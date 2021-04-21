# Comparing Flow and Materialize

I'm often asked how to think about Flow vs Materialize.
This is a good question:
at the highest levels both systems help you wrangle streaming data,
and both provide a means for tackling continuous views,
so what kinds of problems are each suited for,
and when would you use one over the other?

Obviously I have some bias here.
I'll be as even-handed as I know how, but reader beware.
Also, while I know Flow very well, I'm not a Materialize expert.
I've done my best to inform myself
but will graciously accept corrections where I've gone off the rails.

That said, my central take-away is this:
you should consider Materialize for rapid answers to questions
of _"what happened?"_ within your event-oriented applications,
products and services.
You should consider Flow for _integrating_ those applications,
products and services.
My sincere hope for Flow is that it makes it easy to
get up and running with new tools like Materialize.

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
to invoke your functions as data arrives,
to transform that data in arbitrary ways,
and to load into others of your systems.
You can use Flow to build joins and aggregations into your databases of choice,
updating in milliseconds,
but this is one use case in the broader context
of why you might want to use a tool like Flow.

## System of Record

Materialize is an in-memory database.
On startup it pulls from your data sources to rebuild
its internal indices and query results.
Its processing model ensures the repeatability of your views given stable inputs,
but it relies on another system to provide that stability.
Materialize doesn't attempt to act as a system of record,
and requires that you bring your own —
which can be a challenge if your data is scattered between a
[volatile](https://materialize.com/docs/overview/volatility/)
stream and separate batch storage, as is common.

Flow collections *are* a system of record.
When Flow captures or derives collections from your data systems,
those collections are persisted as an interoperable data lake of your
JSON documents — as regular files on cloud storage — without losing
the context of how those files stitch into the stream.
Collection readers are able to transparently toggle between direct
file reads (efficient! scalable!) and millisecond-latency tailing
as needed.
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

Flow has lower-level primitives:
[derivations](https://docs.estuary.dev/concepts/catalog-entities/derivations),
registers, and schema
[reduction annotations](https://docs.estuary.dev/concepts/catalog-entities/schemas-and-data-reductions#reduction-annotations).
They're building blocks for assembling stateful,
continuous map/reduce workflows,
including cyclic computations over generalized graphs.
Derivations are pretty succinct in comparison to the the broader
ecosystem of tools, but they require that *you* be the query planner.

Still, there are reasons you might want this:
one is that they allow for **general computation**.
You can bring your own codebase and Flow will run it using V8
and (soon) WebAssembly.
Or Flow can call a remote function that you provide.

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
To fix this you'll actually need to model and index the
full pricing history of your products,
and join each customer order to the product price
*as it was* at the time of the order.

This may or may not make sense for your use case.
SQL is an amazing language,
and my purpose here is not to throw wrenches,
but just to point out that it's not always a perfect fit for
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
Everything it does —
processing source documents,
updating internal register states,
writing out collection documents,
committing an update to a materialized table —
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
That's also not a problem, though,
because Materialize joins are fully reactive.
It will settle at the right answer no matter *what* the read order is.

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
(though Flow offers some neat knobs here,
like reading collections with a relative time delay,
or with different priorities). 

Materialize is built on Timely Dataflow,
which requires that every record have an associated timestamp.
Today Materialize picks a timestamp for you at the time that a record is read,
which may vary across partitions, machine failures, and restarts.
My understanding is that, in the future, Materialize
[wants to use](https://materialize.com/change-data-capture-part-1/)
the timestamps already in your data.

Either way, its good to understand that both
Flow and Materialize use timestamps,
and in both systems these timestamps provide only an *approximately right* 
means of ordering documents.

In Flow's case reads over collection histories have a stable _total_ order,
but there's an unavoidable race when tailing collections and you're unsure
if more data is forthcoming.

Materialize is totally ordered over timestamps,
but timestamps themselves must be pretty coarse —
by default one second —
for good performance.
The relative ordering of documents _within_ a timestamp is lost:
they're all effectively considered to have "happened" at the same time.

I'll also point out that Materialize _wants_ a durable event timestamp that
[can make progress guarantees](https://news.ycombinator.com/item?id=26862051),
and Flow _has_ one built-in.
An interesting opportunity?

## Consistency

Materialize
[has a capability](https://github.com/frankmcsherry/blog/blob/master/posts/2020-06-19.md)
to provide internally consistent queries.
This means that, for a given timestamp,
your queried views always reflect *all* of the processed inputs
bearing that timestamp (or less), no matter their source.
It does this by holding back all of the effects of a timestamp
until it can be sure its processing has settled,
trading a bit of latency in exchange for consistency.

Flow doesn't offer this.
Shards of a Flow derivation or
materialization coordinate their reads
and will *approximately* process at the same rate,
but they're running independent transactions
over disjoint chunks of a key space.
This minimizes end-to-end latency,
but if there's a whole-collection invariant your expecting, like
[bank balances must always sum to zero](https://scattered-thoughts.net/writing/internal-consistency-in-streaming-systems/),
you will see it be violated as transactions
commit at slightly different times.
So the fact that Materialize can offer this is a really cool result.

It's not always a _practical_ result.

The guarantee requires that Timely Dataflow be able to "retire" timestamps:
essentially extracting a promise that you'll never
present another record with that timestamp (or less) again.
However the broader context is that you're building a view over
the decisions of other systems,
and *you can't make that promise*.
The network will partition, or a machine will crash:
one way or another records *will* arrive after
their event timestamp has been retired.
At that point you can either
a) drop records on the floor, leading to inconsistency with
   what your external system believes happened, or
b) choose to process them with a later
   (incorrect) timestamp,
   which is an inconsistency with respect
   to the event timestamp.

You can have either eventual consistency with your *external* systems,
or *internal* consistency that may disagree with your external systems,
but you can't have both.

**tl;dr** Flow opts for the former, and Timely Dataflow the latter.
Today Materialize actually uses a hybrid option:
it assigns timestamps as it _reads_ from your records,
rather than using timestamps contained _within_ your records.
This makes it eventually consistent with your external systems,
and internally consistent with respect to the effects
of a _single_ read event,
but internally *in*consistent to multiple records bearing
the same event timestamp.

There's some
[experimental work](https://www.youtube.com/watch?v=0WijjN0LiZ4)
to incorporate "bitemporal" timestamps in differential dataflow.
This effectively extends the definition of a timestamp
into multiple dimensions, as a (read-time, event-time) tuple.
I don't believe this
[fundamentally changes](https://news.ycombinator.com/item?id=26862051)
the tl;dr though.

_This section may have come off as a bit biased,
and I'm sorry: that's really not my intent.
Materialize's consistency guarantees are legitimately very cool,
but are also a place where the product marketing has perhaps run
ahead of the actual technical guarantees being made._

## Better Together?

I wouldn't hesitate to try Materialize for spiking out an internal
analysis or reporting use case.
The ability to express complex reactive joins and aggregations
as SQL is awesome for many a use cases, if not _every_ use case.
It's a high leverage tool that could be handed to a team
of data analysts to have them up and running quickly.

(Aside: I'd be a wee bit concerned regarding unbounded
growth of internal indexes,
and whether analyst user cohorts really understand
the operational overheads of their queries,
but this is a solve-able problem with good tooling and documentation).

Materialize isn't a system of record, and it's not trying to be.
You'll need to bring your own,
and on startup the database will need to replay that history
to rebuild its internal states and views.

That means assembling a mish-mash of
[volatile Kenesis](https://materialize.com/docs/sql/create-source/json-kinesis/)
and overlapping
[S3](https://materialize.com/docs/sql/create-source/json-s3/)
sources that you then de-duplicate at query time.
Or starting a product onboarding conversation with
"As step one, you must deploy and manage a Kafka cluster".

It's also not clear that Materialize is happy tackling
problems that can't comfortably fit in RAM on a big machine.
It's technique of
[index arrangements](https://github.com/frankmcsherry/blog/blob/master/posts/2020-11-18.md)
is clever and efficient
*so long as* you can access that index through memory,
rather than exchanging big chunks of it over the network.
So you'll probably want more than one Materialize deployment,
where each is focused on different aspects of your business,
or is owned by a different team.

See where I'm going?

The relative weaknesses of Materialize
are strengths of Flow, and vice versa.
Materialize has a powerful transformation capability
that's simple and appealing,
but it needs an easy and low-latency system of record
that can provide reliable replay of events and their timestamps.
That's Flow.
(As a bonus, I _believe_ Flow could provide metadata about those
event timestamps that Materialize could use for its own
consistency guarantees).

Flow's strengths lie in giving you easy tools to integrate
multiple systems into a comprehensive whole,
unified around common data sets,
with data moving between those systems as quickly as possible.

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
