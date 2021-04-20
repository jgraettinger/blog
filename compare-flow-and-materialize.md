# Comparing Flow and Materialize

I'm often asked how to think about Flow vs Materialize.
This is a good question:
both systems provide a means of tackling continuously materialized views,
so what kinds of problems are each suited for,
and when would you use one over the other?

Obviously I have some bias here.
I'll be as even-handed as I know how, but reader beware.
Also, while I know Flow very well, I'm not a Materialize expert.
I've done my best to inform myself
but will graciously accept corrections where I've gone off the rails.

That said, my central take-away is this:
you should consider Materialize for rapid answers to questions
of _"what happened?"_ within your data-oriented products and services.
You should consider Flow for _building_ those products and services.
It's reasonable, and probably even a good idea,
to run instances of Materialize which are fed by Flow.

Let's get into it.

## Background

Materialize is a database built atop Timely Dataflow.
It's broadly compatible with PostgreSQL
and lets you define continuous materializations as SQL queries.
Materialize then keeps those views fresh as your inputs change,
by turning each query into a differential dataflow which minimizes
the work done with each update.
It's a very cool product with some serious engineering chops behind it.

Flow is _not_ a database.
It's a orchestration tool that makes it easy to continuously capture
data produced by your systems into an interoperable cloud storage lake;
to transform that data in arbitrary ways,
and to load into others of your systems.
You can use Flow to build joins and aggregations into your databases of choice,
updating in milliseconds,
but this is one use case in the broader context
of why you might want to use a tool like Flow.

## System of Record

Materialize is an in-memory database.
On startup, it pulls from your data sources to rebuild
its internal indices and query results.
Its processing model ensures the repeatability of your views given stable inputs,
but it relies on another system (Kafka, or S3) to provide that stability.
Materialize
[doesn't attempt](https://materialize.com/docs/sql/insert/)
to act as a system of record.

Flow collections *are* a system of record.
When Flow captures or derives collections from your data systems,
those collections are backed by an interoperable data lake of your
JSON documents, as regular files on cloud storage.
Collections are transactional and durable even if a machine
or an availability zone fails.
You can treat collections as a long-term source of truth,
or prune data using a standard bucket lifecycle policy.

## Operating Model

You express views to Materialize using SQL,
and the Materialize query planner
[turns the query into](https://scattered-thoughts.net/writing/materialize-decorrelation)
an assemblage of internally indexed states
and connective dataflow operators which collectively answer your question.
It's very powerful and a bit magical.
```sql
SELECT
    passenger_count,
    MIN(fare_amount),
    MAX(fare_amount)
FROM
    tripdata
GROUP BY
    passenger_count
```
This query has more going on than you might think:
those `MIN` and `MAX` aggregates imply an index of all
trip fares that have ever been seen,
in order to properly handle retractions.
Materialize will do this for you under the hood without
your having to think too hard about it.
This is legitimately *very cool*.

Flow has lower-level primitives, **derivations** and their **registers**.
They're building blocks for assembling any kind of stateful,
continuous map/reduce workflow,
including cyclic computations over generalized graphs.
Derivations are pretty succinct in comparison to the the broader
ecosystem of tools, but they require that *you* be the query planner.

Still, there are reasons you might want this:
one is that they allow for **general computation**.
You can bring your own codebase and Flow will run it using V8
and (soon) WebAssembly.
Or Flow can call a lambda that you host.

Another is that derivations are **easy to evolve**.
You have the ability to fix a bug, change behavior,
or even enrich a derivation by joining against a new dataset
on a go-forward basis,
without interrupting any of its downstream uses.
Derivations can also be **dynamically scaled**
and have fast fine-grained **fault tolerance**.
I'll expand on this in another post.

Still another is in the **types of joins** you can express and their reactivity.

## Reactivity

A SQL join expresses a fully reactive view.
If you change either side of the join then
the difference must flow through to the post-join aggregate,
and Materialize honors this interpretation.
Consider a query view like:
```
SELECT
    customer.name,
    SUM(orders.quantity * products.price) AS lifetime_value
FROM
    customers,
    orders,
    products
WHERE
    orders.customer_id = customer.customer_id AND
    orders.product_id = products.product_id
```

If a customer updates their name record,
you want that to flow through into the view of their lifetime value.
Neat!

Now what happens if you update product pricing?
Well, ... hmm. We have a problem here.
A pricing update will alter the lifetime value of a customer
who ordered the product in the past, *before* our price change.
That's not right.
To fix this you'll actually need to model (and index!) the
complete pricing history of your products,
and join each customer order to the product price as it
was at the time of the order.

SQL is a great language, but it's not a perfect fit for
expressing the temporal dynamics of stream-to-stream joins.
Sometimes you want reactivity, and sometimes you don't.

To sketch how this works in Flow, you create a derivation which:
- Indexes current product pricing within its register,
  keyed on product ID, and
- Joins each order, on product ID, with its current price to
  produce an update of the customer's lifetime value.

_"But wait,"_ I hear you ask,
_"in what order are product updates vs orders processed?!??"_
We'll get there. For now I'll say it's approximately ingestion order,
and yes there are subtle data races here,
but it also _doesn't matter_ because...

## Transactions

Flow always processes in durable transactions.
Everything it does --
processing source documents,
updating internal register states,
writing out collection documents,
committing an update to a materialized table --
either happens as an atomic operation,
or doesn't happen at all.

This lets Flow tackle transaction processing workloads,
like validating an account has sufficient balance,
where you *really* don't want to forget
the outcome of a decision you've made.

It also means Flow is well behaved to the legitimate races
that arise, say where a pricing change and customer order
happen at the same time.
Flow will pick an ordering and it won't forget it. 

Materialize, however, *does* forget the relative order across restarts.
That's not as big a deal as it might seem, though,
because Materialize joins are always (and only) fully reactive.
It will settle at a consistent answer no matter *what* the read order is.

Speaking of order, let's talk about time.

## Timestamps

Flow does not care about your event timestamps.
Recall that collections are a durable system of record,
and each written document of a collection embeds a UUID that's added by Flow.
This UUID includes a wall-clock timestamp,
[among other things](https://gazette.readthedocs.io/en/latest/architecture-exactly-once.html).

A collection is made up of one or more totally-ordered streams,
each a physical partition,
and documents are read across
streams of collections in order of their wall-time ingestion timestamp
(though Flow offers some really powerful knobs here,
like reading collections with a relative time delay,
or with different priorities. More on this in another post). 

Materialize is built on Timely Dataflow,
which requires that every record have an associated timestamp.
Today Materialize picks a timestamp for you
at the time that a record is _read_,
say from Kafka,
meaning that timestamp assignment is racy across sources or partitions.
My understanding is that, in the future, Materialize
[wants to use](https://materialize.com/change-data-capture-part-1/)
the timestamps already in your data.

Either way, its important to understand that both
Flow and Materialize use timestamps,
and in both systems these timestamps provide only an *approximately right* 
means of ordering documents.

In Flow's case reads over collection histories have a stable _total_ order,
but there's an unavoidable race when tailing collections and you're unsure
if more data is forthcoming.

Materialize is totally ordered over its timestamps,
but timestamps themselves must be pretty coarse --
by default one second --
for good performance.
The relative ordering of documents _within_ a timestamp is lost:
they're all effectively considered to have "happened" at the same time.

## Consistency

Materialize
[has a capability](https://github.com/frankmcsherry/blog/blob/master/posts/2020-06-19.md)
to provide internally consistent queries.
This means that, for a given timestamp,
your queried views always reflect *all* of the processed inputs
bearing that timestamp (or less), no matter their source.
It does this by holding back all of the effects of timestamps
until it can be sure its processing has settled to a consistent state.

Flow doesn't offer this.
When scaled out, shards of a Flow derivation or
materialization coordinate their reads
and will *approximately* process at the same rate,
but they're running independent transactions
over disjoint chunks of a key space.
This minimizes latency,
but if there's a whole-collection invariant your expecting, like
[bank balances must always sum to zero](https://scattered-thoughts.net/writing/internal-consistency-in-streaming-systems/),
you will see it be violated as transactions
commit at slightly different times.
So the fact that Materialize can offer this is a pretty cool result.

It's not always a _practical_ result.

The guarantee requires that Timely Dataflow be able to "retire" timestamps:
essentially extracting a promise that you'll never
present another record with that timestamp (or less) again.
However the broader context is that you're building a view over
the decisions of other systems,
and *you can't make that promise*.
The network will partition, or a machine will crash:
one way or another records *will* arrive after
their timestamp has been retired.
At that point you can either
a) drop records on the floor, leading to inconsistency with
   what your external system believes happened, or
b) choose to process them with a later
   (incorrect) timestamp,
   which is an inconsistency with respect
   to the actual timestamp.

You can have either eventual consistency with your *external* systems,
or *internal* consistency that may disagree with your external systems,
but you can't have both.

**tl;dr** Flow opts for the former, and Timely Dataflow the latter.
Materialize actually uses a hybrid option:
it assigns timestamps as it _reads_ from your records,
rather than using timestamps contained _within_ your records.
This makes it eventually consistent with your external systems,
and internally consistent with respect to the effects
of a _single_ read event,
but internally *in*consistent to multiple events bearing
the same user timestamp.

_Addendum_: there's some
[experimental work](https://www.youtube.com/watch?v=0WijjN0LiZ4)
to incorporate "bitemporal" timestamps in differential dataflow.
This effectively extends the definition of a timestamp
into multiple dimensions, as a (read-time, user-time) tuple.
I don't believe this fundamentally changes the tl;dr.

## Better Together?

Materialize appears a very powerful tool that I wouldn't hesitate to
spike out for internal analysis and reporting use cases.
The ability to express complex reactive joins and aggregations
as SQL is awesome for many a use cases
(if not _every_ use case).
It's a high leverage tool that could be handed to a team
of data analysts to have them up and running quickly.

(Aside: Though I'd be a bit concerned regarding unbounded
growth of internal indexes,
and whether analyst user cohorts _really_ understand
the operational overheads of their queries).

It's not a system of record, and it's not trying to be.
You'll need to bring your own,
and on startup the database will need to replay that history
to rebuild its internal states and views.

It's also not clear to me you should consider Materialize for
problems that can't comfortably fit in RAM on a big machine.
It's technique of
[index arrangements](https://github.com/frankmcsherry/blog/blob/master/posts/2020-11-18.md)
is clever and efficient
*so long as* you can access that index through shared memory,
rather than exchanging big chunks of it over the network.

So, you may eventually want more than one Materialize instance,
where each is focused on different sub-aspects of your operations.
You'll need a system of record which can orchestrate and "feed"
those instances with the correct datasets, with low latency.
Ideally one which has a baked-in notion of
event time which could tightly integrate with that of Materialize.

That... sounds a lot like Flow?

## Epilogue (for now)

On paper, Flow should be happy materializing
a collection into a Materialize table.
Flow stores its checkpoints in the target database
for proper exactly-once transactions,
so it's not a problem that
Materialize restarts as an empty database:
Flow would know to re-materialize the full collection history.

I made a quick attempt to get Flow and Materialize talking
using one of Flow's PostgreSQL demos,
but had to table it due to missing bits of PostgreSQL
that Flow expects, and `materialized` doesn't yet implement:

- Support for transactional schema updates
- Support for `COPY FROM` (used to bulk load keys)
- Support for creation of temporary tables (also for keys)

Hopefully we can make this work in the future!
