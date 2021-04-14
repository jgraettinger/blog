(This repo is being developed for a work-in-progress blog post:)

# Filling a Paradigm-Shaped Hole

👋 Hi, I'm Johnny, I work at [Estuary](https://estuary.dev) on our product
[Flow](https://github.com/estuary/flow).
Flow is a GitOps tool for integrating all of the systems
you use to produce, process, and consume data.
Today I want to talk about how Flow can help maintain complex materialized views
in your database(s) of choice.

## The Shape of a Problem

This post is a response to Liron Shapira's excellent "[Data Denormalization is Broken][1]".
Liron details the subtleties of a seemingly "simple" messaging application that models
messages and user-to-room subscriptions.
The app requires an indexed view for fast loads and good user experience,
but Liron laments the difficulty of actually maintaining views like this.
He concludes (emphasis mine):

> Right now, working with denormalized data is **bad**. If you’ve ever written
> anything less than the perfect denormalized-field recomputation code,
> then running it will have introduced data corruptions. Just like that,
> you’ve silently nuked the logical invariant that you were hoping to maintain
> on your data set. Don’t you wish that were impossible? Our current approach
> to denormalization has a **paradigm-shaped hole**.

[1]: https://lironshapira.medium.com/data-denormalization-is-broken-7b697352f405

What we're after today - as posed by Liron - is a view indexed on user ID
from which we can fetch the user's current number of unread chat rooms.
It must account for:
 * Messages being sent and users viewing messages.
 * Messages being deleted without being read by some or all users.
 * Users deleting room subscriptions which may or may not have unread messages.
 * Users *un*-seeing chat rooms by restoring an older `seenTimestamp`.
 * Message timestamps changing, perhaps due to an edit.

All of these update modes from just two toy inputs: Messages and RoomUser subscriptions!
Most databases can't support continuous materialized views,
and we're _deeply_ out of luck if we want this index to live elsewhere,
like Redis or DynamoDB.

Without better options most of us will bury view update logic within application event handlers,
which gets unwieldy _quickly_ given all these update paths.
And to anyone who's achieved fault tolerant, correct, exactly-once increments
of a secondary Redis index in concert with their primary database transaction
as _application logic_, I'm both impressed and empathetic to your suffering.

We're building Flow to make this better, and what I'll discuss today is how
Flow can help us de-structure this problem into simpler parts
which are decoupled from our application logic,
how we can test the resulting workflow,
and how Flow can execute it on our behalf to maintain a
PostgreSQL table with an always-fresh index.

But first, let's see it in action.

## Demo Time

*Find code for this post in
[this Git repository](https://github.com/jgraettinger/filling-paradigm-shaped-hole).
Open it in
[VSCode Remote Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
or 
[GitHub CodeSpaces](https://github.com/features/codespaces)
(early access) and run the console commands yourself:*

**TODO Image of codespaces**

We'll start with basic Flow
[collections](https://docs.estuary.dev/concepts/catalog-entities/collections)
for Messages and RoomUsers:
```yaml
collections:
  messages:
    key: [/id]
    schema: inputs.schema.yaml#/$defs/message

  roomUsers:
    key: [/roomId, /userId]
    schema: inputs.schema.yaml#/$defs/roomUser
```

Our desired view is implemented as a
[derived collection](https://docs.estuary.dev/concepts/catalog-entities/derivations).
We'll look at it a bit later.
First start a local development instance of Flow:
```console
$ flowctl develop --source userDetails.flow.yaml
```

Then ingest the examples from Liron's post.
In a production setup we might want to connect using "change data capture",
but right now we'll just POST them:
```console
$ curl -f -H 'Content-Type: application/json' -d @/dev/stdin http://localhost:8080/ingest <<EOF
{
    "messages": [
        {
            "id": "m94",
            "roomId": "r31",
            "senderId": "sasha-rosse",
            "timestamp": 1483,
            "content": "Perfect!"
        },
        {
            "id": "m75",
            "roomId": "r20",
            "senderId": "mac-tyler",
            "timestamp": 1359,
            "content": "I have a great idea..."  
        },
        {
            "id": "m87",
            "roomId": "r20",
            "senderId": "mac-tyler",
            "timestamp": 1372,
            "content": "Let's go see Giraffage tonight!"
        }
    ],
    "roomUsers": [
        {
            "roomId": "r31",
            "userId": "liron-shapira",
            "seenTimestamp": 1310
        },
        {
            "roomId": "r20",
            "userId": "liron-shapira",
            "seenTimestamp": 1308
        }
    ]
}
EOF
```

As expected user `liron-shapira` now has two unread rooms:
```console
$ psql -h localhost -c 'SELECT id, numUnreadRooms FROM user_details;'
      id       | numunreadrooms 
---------------+----------------
 liron-shapira |              2
(1 row)
```

This PostgreSQL table was created for us by `flowctl develop` on startup,
drawn from a declared
[materialization](https://docs.estuary.dev/concepts/catalog-entities/materialization)
and JSON schema.
It's a regular table and indexed on user ID for efficient lookups:
```console
$ psql -h localhost -c '\d user_details;'
               Table "public.user_details"
     Column     |  Type  | Collation | Nullable | Default 
----------------+--------+-----------+----------+---------
 id             | text   |           | not null | 
 name           | text   |           |          | 
 numunreadrooms | bigint |           |          | 
 flow_document  | json   |           | not null | 
Indexes:
    "user_details_pkey" PRIMARY KEY, btree (id)
```

Suppose Liron sees Sasha's latest message, and Mac's first message but not their second.
Chat room `r31` is now fully seen, but `r20` has one remaining unseen message:

```console
$ cat scripts/write-events-2.sh 
curl -f -H 'Content-Type: application/json' -d @/dev/stdin http://localhost:8080/ingest <<EOF
{
    "roomUsers": [
        {
            "roomId": "r31",
            "userId": "liron-shapira",
            "seenTimestamp": 1510
        },
        {
            "roomId": "r20",
            "userId": "liron-shapira",
            "seenTimestamp": 1365
        }
    ]
}
EOF

$ psql -h localhost -c 'SELECT id, numUnreadRooms FROM user_details;' --tuples-only
 liron-shapira |              1
```

Sasha sends a new message, but Mac re-thinks Giraffage and deletes their message
(schedule conflict 🤦).
`r31` is unseen again, but `r20` is now seen due to the message deletion:

```console
curl -f -H 'Content-Type: application/json' -d @/dev/stdin http://localhost:8080/ingest <<EOF
{
    "messages": [
        {
            "id": "m102",
            "roomId": "r31",
            "senderId": "sasha-rosse",
            "timestamp": 1532,
            "content": "Can't wait."
        },
        {
            "id": "m87",
            "roomId": "r20",
            "senderId": "mac-tyler",
            "timestamp": 0,
            "delete": true
        }
    ]
}
EOF

$ psql -h localhost -c 'SELECT id, numUnreadRooms FROM user_details;' --tuples-only
 liron-shapira |              1
```

Liron closes out their chat with Sasha without seeing the last message.
`r31` is implicitly seen due to its deletion.
`r20` remains an active but seen subscription:
```console
curl -f -H 'Content-Type: application/json' -d @/dev/stdin http://localhost:8080/ingest <<EOF
{
    "roomUsers": [
        {
            "roomId": "r31",
            "userId": "liron-shapira",
            "seenTimestamp": 0,
            "delete": true
        }
    ]
}
EOF

$ psql -h localhost -c 'SELECT id, numUnreadRooms FROM user_details;' --tuples-only
 liron-shapira |              0
```

### Testing

Flow offers built-in
[testing](https://docs.estuary.dev/concepts/catalog-entities/tests).
We can run a test suite to exercise the remaining cases:
**TODO update with more cases**
```console
$ flowctl test --source userDetails.flow.yaml 
Running  1  tests...
✔️ userDetails.flow.yaml :: Expect that something something

Ran 1 tests, 1 passed, 0 failed
```

## Implementation Sketch

Suppose that, for each room, we maintained a "RoomState" data structure that modeled:

  * Messages of the room and their associated timestamps.
  * Subscribers of the room and when they last saw it.

We might have something like this:
```json
{
  "messages": {
    "m102": 1532,
    "m94": 1483
  },
  "subscribers": [
    {"userId":"liron-shapira", "seenTimestamp": 1510}
  ]
}
```

This structure is useful because it provides a self-contained answer as
to whether any subscriber has "seen" the room:
just take the maximum timestamp across all messages
and compare against the `seenTimestamp` of each subscriber.

There can be many chat rooms, so we'll need many RoomStates in a fast index somewhere.
Every Message or RoomUser message can be mapped ("shuffled") to its corresponding
RoomState through its `/roomId`, which is the RoomStates index key.

It's also clear how a RoomState should update as a Message is sent to the room,
or a Message timestamp changes, or a Message is deleted:
we add, remove, or update its `/messages` appropriately.
RoomUser events mutate `/subscribers` in a similar way.
We can decouple this a bit further by defining a *mapping* from any single
Message or RoomUser into a RoomState,
and a *reducer* which deeply merges RoomStates.

Suppose we kept *before* and *after* copies of a RoomState with respect to
each update from a Message or RoomUser. Since an individual RoomState
can tell us whether a subscriber has "seen" the room, we ought to be able to
compare *before* vs *after* RoomStates to determine which users *toggled*
between having "seen" vs "not seen" the room.

Deleting message `m102` above, or setting its timestamp `1532 => 1502`
would toggle `liron-shapira` from "not seen" to "seen". Assuming we treat users not
in `/subscribers` as implicitly having "seen" the room, then adding a new user
`{"userId":"johnny","seenTimestamp":0}` would toggle from "seen" to "not seen".

Each of these identified toggles contributes an `-1` or `+1` update to the user's `numUnreadRooms`.
If we kept track of all of these contributions, then all that would remain is to keep a
running sum for each user somewhere... say, in a PostgreSQL database?

...

**This is just map/reduce**. This formulation is one of many possible.
Arguably it's not even a very good one, but I'll leave shortcomings
and improvements as an exercise for the reader.

If you crack open a database query planner,
this is what its gooey center looks like -- though perhaps a bit
more inscrutable, and less tuneable.
Planners use "internal states" like RoomState all the time, as an intermediate result
built in service of producing the desired result set.

What's most salient is we've deconstructed the hard question of
"how should a Message or RoomUser update each user's `numUnreadRooms`?"
into a bunch of simpler questions:

  * **(A)** How should a Message or RoomUser be shuffled to its current RoomState?
  * **(B)** How do I turn that Message or RoomUser _into_ a RoomState?
  * **(C)** Given a *current* RoomState, how do I reduce in that update to produce a *next* state?
  * **(D)** Given *previous* and *next* states, which users toggled between having "seen" the room ?
  * **(E)** Given the set of toggles for each user, what's their current `numUnreadRooms`?

_Lots_ of problems can be tackled by this kind of destructuring,
and the general shapes of these steps tend to be really similar from problem to problem:

  * Shuffling a document on an extracted key.
  * Mapping a document into another kind of document.
  * Combining or reducing many documents into one.
  * Mapping a document, as well as *before* and *after* internal states, into other kinds of documents.
  * Recursively shuffling and mapping *those* documents in further, cascaded steps.

## Flow Derivations As Continuous Map/Reduce

Flow lets you express workflows of this kind in declarative terms,
predominantly as YAML specifications.
You *apply* specifications to the Flow runtime
which executes them continuously, at any scale, and driven by your writes.

Specifications strive to be succinct without sacrificing any fidelity
to the various shapes these kinds of workflows can take
-- as simple as possible but no simpler.

A repeated Flow theme is that internal details in traditional database architectures become
first-class citizens within Flow.
This is of a piece with Flow's broader vision of
[un-bundling the database](https://www.confluent.io/blog/turning-the-database-inside-out-with-apache-samza/)
 -- without forsaking the properties that make databases desirable in the first place!

Internal states are no exception.
Within Flow, these are
[registers](https://docs.estuary.dev/concepts/catalog-entities/derivations#registers):
keyed documents that derivations use to maintain states like RoomState.
Registers enable the full gamut of stateful workflows, including joins and aggregations.
They're fast, durable, and are not beholden to the windowing constraints and limitations
that plague other streaming workflow engines.

Writing reducers can be verbose and error-prone, so with Flow, you don't write them.
Instead
[`reduce` annotations](https://docs.estuary.dev/reference/catalog-reference/schemas-and-data-reductions#reductions)
of your JSON schemas tell Flow how two document instances may be combined or reduced.
This is another inversion of a typical database:
SQL aggregate functions like SUM() imply reductions under the hood,
but Flow hoists them to be a first-class concern of the schema.

In fact of **(A-E)** above, only **(B)** and **(D)** require any code:
We must provide Flow with pure functions that "map" documents of one kind into another.
Today Flow requires that these mappers be provided as strongly-typed TypeScript,
or as a remote JSON HTTP lambda. In the future we'll add support for WebAssembly.

---

Putting it all together we can implement the workflow with a derived collection and
[schema](https://github.com/jgraettinger/filling-paradigm-shaped-hole/blob/master/userDetails.schema.yaml):
```yaml
collections:
  userDetails:
    key: [/id]
    schema: userDetails.schema.yaml

    derivation:
      register:
        schema: userDetails.schema.yaml#/$defs/roomState
        # A room initializes with no subscribers or messages.
        initial: { subscribers: [], messages: {} }

      transform:
        fromMessages:
          source: { name: messages }
          shuffle: { key: [/roomId] }
          update: { lambda: typescript }
          publish: { lambda: typescript }

        fromRoomUsers:
          source: { name: roomUsers }
          shuffle: { key: [/roomId] }
          update: { lambda: typescript }
          publish: { lambda: typescript }
```

The derivation shuffles each Message or RoomUser to a corresponding
RoomState register on `/roomId`.

It calls the "update"
[TypeScript lambda](https://github.com/jgraettinger/filling-paradigm-shaped-hole/blob/master/userDetails.flow.ts)
to map each source document into a RoomState,
which is then reduced into the current register value.

These *before* and *after* RoomStates are then presented to the "publish" lambda,
which inspects them to identify users who have toggled between rooms,
and in turn publishes `userDetails` documents like `{"id":"johnny","numUnseenRooms":"-1"}`.

Finally `userDetails` is materialized to a table,
and the collection schema instructs the materialization 
to reduce `numUnreadRooms` as a running sum:
```yaml
materializations:
  - endpoint:
      name: demo/database
      config: { table: user_details }
    source: { name: userDetails }
```

## How this Helps

What we've achieved with Flow is a de-normalized view, in our database of choice,
that's reactive to our normalized business events -- past and future.
It's consolidated into a single place, strongly-typed, tested,
and completely isolated from our application code.
Flow will manage its execution for us and we don't have yet another app to deploy.

The solution isn't *completely* declarative -- we still had to write a non-trivial
pure function to identify users that changed between "seen" vs "not seen" room states --
but we've substantially simplified from the spaghetti of per-event application handlers.

From here we're able to evolve the derivation over time, or compose it as an input
of other derivations -- say one that's alerting users with lots of unread rooms. 
We can easily and repeatedly materialize views into many places:
flavors of databases, key/values stores,
or even a Webhook API which pushes a notification to the user.

## On Query Planners

It's not entirely lost on me that Liron asked for easy de-normalized views
and I've offered up a moderately complex continuous map/reduce workflow.

Why not, for example, apply a query planner that turns a higher-level
language like SQL into an *internal execution plan* using something
like derivations and registers?

The short answer is that a query-planner *first* approach appears
incompatible with Flow's broader objectives:
composable, straightforward
and succinct expressions of complex and long-lived workflows,
which are production-ready and integrated into the places you need them.
For example:

  * The details of the query plan (e.x. derivations and registers) *really* matter,
    particularly for workflows running at scale for months or years.
    It's unavoidable that owners understand their operational aspects,
    and planners often get in the way of an engineer who knows what they want.

  * Workflows must evolve over time -- joining to a new data set,
    enriching with extra fields, or fixing a bug -- without being forced to
    recompute from piles of historical data (expensive!)
    Derivations allow for such changes today, but it's unclear how a planner could.

  * One team's output is often another team's input, and
    derivations may be re-used in many data products.
    Optimizing the overall structure of the execution graph can be
    more important than the plan of a single query.

  * Flow derivations allow for general computation:
    TypeScript, remote lambdas, and (in the future) WebAssembly.
    It's unclear how that flexibility would be incorporated into plans.

In truth this stuff is *hard* and trade-offs abound.
Flow threads the needle today by exposing its fundamental operations as first-class primitives,
with the hope and expectation that, in the future, one or more query planners could be
layered on top to generate execution graphs *in terms* of these
primitives -- an area we'll explore going forward.
If you'd like to explore with us, we'd love to talk!

## What's next?

Our road map for Flow includes more endpoints for materializations,
captures, WebAssembly support, more powerful schema annotations
(including user-defined reductions powered by WASM!), computed shuffles, 
and more.
There's lots to do, and we'd love for you to get involved.

Please check out
[our docs](https://docs.estuary.dev)
or
[Flow's git repo](https://github.com/estuary/flow),
start a discussion on GitHub or join our
[Slack](https://join.slack.com/t/gazette-dev/shared_invite/enQtNjQxMzgyNTEzNzk1LTU0ZjZlZmY5ODdkOTEzZDQzZWU5OTk3ZTgyNjY1ZDE1M2U1ZTViMWQxMThiMjU1N2MwOTlhMmVjYjEzMjEwMGQ)!

## Addendum: Evolving UserDetails

TODO: this section would show how the running `userDetails` derivation
can be enriched by joining in real user names, without having to rebuild
from scratch.
