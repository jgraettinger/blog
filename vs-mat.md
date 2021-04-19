# Comparing Flow and Materialize

I'm often asked how to think about Flow vs Materialize.
This is a perfectly good question:
both systems provide a means of tackling continuously materialized views,
so what kinds of problems are each suited for,
and when would you use one over the other?

Obviously, I have some bias here.
I'll be as even-handed as I know how, but reader beware.
Also, while I know Flow very well, I'm not a Materialize expert.
I've done my best to inform myself
but will graciously accept corrections where I've gone off the rails.

That said, my central take-away is this:
you should consider Materialize for rapid answers to questions
of _what happened?_ within your data-oriented products and services.
You should consider Flow for _building_ those products and services.
It's reasonable, and probably even a good idea,
to run instances of Materialize which are feed by Flow.

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
When Flow captures or derives collections from your system data,
those collections are backed by an interoperable data lake of your
JSON documents, as regular files on cloud storage.
They're transactional and durable even if a machine
or an availability zone fails.
You can treat collections as a long-term source of truth,
or prune older data using a standard bucket lifecycle policy.

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
You can bring your own code and Flow will run it using V8 and (soon) WebAssembly.
Or you can have Flow call a lambda that you host.

Another is that they're **easy to evolve** over time,
if there's a bug or feature or you want to enrich the derivation with new joined data.
You have the option of changing how a derivation works, on a go-forward basis,
without interrupting any of its downstream uses.

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
Ah, we have a problem here.
A pricing update will change the lifetime value of a customer
who ordered the product in the past, *before* our price hike.
That's not right.
To fix this you'll actually need to model (and index!) the
complete pricing history of your products,
and join each customer order to the product price as it
was at the time of the order.

SQL is a great language, but it's not a perfect fit for
expressing the temporal dynamics of stream-to-stream joins.
Sometimes you want reactivity, and sometimes you don't.

To sketch how this works in Flow, you create a derivation which:
- indexes current product pricing within its register, shuffled on product ID, and
- joins each order, on product ID, with its current price to produce an update of the customer's lifetime value.

"But wait," I hear you ask,
"in what order are product updates vs orders processed?!??"
We'll get there. For now I'll say it's approximately ingestion order,
and yes there are data races here, but it also _doesn't matter_ because...

## Transactions

Flow always processes in durable transactions.
Everything it does --
processing source documents,
updating internal register states,
writing out collection documents,
committing an update to a materialized table --
either happens as an atomic operation,
or doesn't happen at all.

Transactions are tolerant to machine and availability zone failures.
If a process dies, another process will pick up right where it left off with no delay.
This lets Flow tackle transaction processing workloads,
like validating an account has sufficient balance,
where you *really* don't want to forget
the outcome of a decision you've made.

It also means Flow is naturally durable to legitimate races
that arise, say where a pricing change and customer order
happen at the same time:
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
or with different priorities). 

Materialize is built on Timely Dataflow,
which puts a lot of weight behind the timestamps associated with records.
Today Materialize picks a timestamp for you
at the time that a record is read, say from Kafka,
making it a less-durable equivalent to Flow's ingestion timestamps.
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

Materialize has totally ordered _timestamps_,
but the timestamps themselves must be pretty coarse --
by default one second --
for good performance.
The relative ordering of documents _within_ a timestamp is lost:
they're all effectively considered to have "happened" at the same time.

## Consistency

Some
[hay has been made](https://github.com/frankmcsherry/blog/blob/master/posts/2020-06-19.md)
regarding Materialize's ability to provide internally consistent queries.
This means that, for a given timestamp,
your queried view results will reflect *all* of the processed inputs
bearing that timestamp (or less), no matter their source.

Flow doesn't offer this.
When scaled, shards of a Flow derivation or  materialization coordinate their reads
and will *approximately* process at the same rates,
but they're running independent and uncoordinated transactions
over disjoint owned chunks of a key space.
If there's a whole-collection invariant your expecting, like
[bank balances must always sum to zero](https://scattered-thoughts.net/writing/internal-consistency-in-streaming-systems/),
you will see it be violated as derivations
process and refine the view.
So the fact that Materialize can offer this is a pretty cool result.

But it's not necessarily a _practical_ result.

Timely's guarantees in this regard
require that it be able to "retire" timestamps:
essentially extracting a promise from you that you'll never
present another record with that timestamp (or less) again, pinky swear.
However the broader context is that you're building a view over
the decisions of other systems,
and *you simply can't make that promise*.
The network will partition, or a machine will crash:
one way or another records *will* arrive after
their timestamp has been retired.
At that point you can either
a) drop records on the floor, leading to inconsistency with what your external system believes happened, or
a) choose to process them with a later, incorrect timestamp... which is an internal inconsistency!

**tl;dr** You can have either eventual consistency with your *external* systems,
or *internal* consistency that may disagree with your external systems,
but you can't have both.
Flow opts for the former, and Timely Dataflow the latter.
Materialize itself appears to opt for the former as well,
ironically, since it assigns timestamps as it reads from your
(racy) Kafka partitions.

## Better Together?

TODO:

Deeper integration using flow timestamps ?
Materialize into materialize (har har) ?
