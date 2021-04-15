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
Liron details the subtleties of a "simple" messaging application that models
messages and user-to-room subscriptions.
The app needs an indexed view for fast loads and good user experience,
but Liron laments the difficulty of actually _maintaining_ a view like this.
He concludes (emphasis mine):

> Right now, working with denormalized data is **bad**. If you’ve ever written
> anything less than the perfect denormalized-field recomputation code,
> then running it will have introduced data corruptions. Just like that,
> you’ve silently nuked the logical invariant that you were hoping to maintain
> on your data set. Don’t you wish that were impossible? Our current approach
> to denormalization has a **paradigm-shaped hole**.

[1]: https://lironshapira.medium.com/data-denormalization-is-broken-7b697352f405

What we're after today - as posed by Liron - is a materialized view
which serves up each user's number of unread chat rooms.
It must account for:
 * Messages being sent and users viewing messages.
 * Messages being deleted without being read by some or all users.
 * Users deleting room subscriptions which may or may not have unread messages.
 * Users *un*-seeing chat rooms by restoring an older `seenTimestamp`.
 * Message timestamps changing, perhaps due to an edit.

All of these update modes from just two "toy" inputs: Messages and RoomUser subscriptions!
The trouble is that most databases don't support
support incremental materializations,
and we're _deeply_ out of luck if we want it live elsewhere,
perhaps in Redis or DynamoDB.

Without better options we'll often bury view-update logic inside application event handlers,
but this gets unwieldy _quickly_ given the number of update paths.
And to anyone who's achieved fault tolerant, correct, exactly-once increments
of a secondary Redis index in concert with their primary database transaction
as _application logic_, I'm both impressed and empathetic to your suffering.

We're building Flow to make this better.
What I'll show today is how Flow can de-structure this
problem into simpler parts that are decoupled from our application logic.
Flow can test the resulting workflow,
and can run it to maintain an always-fresh index
as a regular PostgreSQL table.

But first, let's see it in action.

## Demo Time

*This post has
[a Git repository](https://github.com/jgraettinger/filling-paradigm-shaped-hole).
You can open it in
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
We'll just POST them for now.
In a production setup we might want to ingest using Change Data Capture (CDC):
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

`flowctl develop` created this table for us upon its startup,
using a declared
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
Liron has seen all of room `r31`,
but `r20` has one remaining message:

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

## Test 

Rather than bore you with the remaining cases,
I'll point out that Flow offers built-in 
[testing](https://docs.estuary.dev/concepts/catalog-entities/tests)
and you can run a suite to exercise them:

**TODO update with more cases**
```console
$ flowctl test --source userDetails.flow.yaml 
Running  1  tests...
✔️ userDetails.flow.yaml :: Expect that something something

Ran 1 tests, 1 passed, 0 failed
```

## An Implementation Sketch

Before throwing Flow terminology at you, I want to give a conceptual sketch
for how a view like this can work.
Suppose we maintain a "RoomState" data structure for a chat room, with:

  * Messages of the room and their associated timestamps.
  * Subscribers of the room and when they last saw it.

We'd have something like this:
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

This is a useful structure: it tells us which subscribers have seen the room.
You take the max timestamp of any message and compare to the `seenTimestamp` of each subscriber.

We have many rooms, so we'll need a bunch of RoomStates in a fast index somewhere.
Each time a Message or RoomUser arrives, we'll inspect its `/roomId` and
look up the corresponding RoomState in our index.

Each Message that arrives requires that we update the RoomState:
either to track a new message sent to the room,
or because a message changed its timestamp, or was deleted.
That's easy: we just upsert or remove into `/messages` keyed on the message ID.
Whenever a RoomUser arrives we mutate `/subscribers` in a similar way.

Let's decouple this a bit further: we'll define a *mapping* from any
single Message or RoomUser into a RoomState, and a *reducer* which
takes two RoomStates and deeply merges them.

See what just happened?
We went from having many code paths - one for each flavor of input -
that *each* have to figure out how to incrementally update a RoomState 🤮,
to trivial functions that just map their input *to* a RoomState.
Plus one reducer function that smashes those RoomStates together, which frankly sounds kind of hard 🤔.
At least the pure functions are a piece of cake!

Anyway suppose we compare *before* and *after* copies of a RoomState with each update.
Hey, this is useful too! Since one RoomState tells us users that have seen the room,
before vs after RoomStates tell us which users *toggled* between having seen it:

```json
// Compare this RoomState as *after* to the RoomState from before:
{
  "messages": {
    // "m102": 1532, <= Deleted.
    "m94": 1483
  },
  "subscribers": [
    {"userId":"liron-shapira", "seenTimestamp": 1510},
    {"userId":"johnny", "seenTimestamp": 0} // New subscriber.
  ]
}

// "liron-shapira": "not seen" (1532 > 1510 is true) =>
//                  "seen" (1483 > 1510 is false).
// "johnny":        "seen" (implicit) =>
//                  "not seen" (1483 > 0 is true).
```

Let's track each of these toggles as a `-1` or `+1` increment to the user's `numUnreadRooms`.
Now all we have to do is keep a running for each user somewhere... say, in a PostgreSQL table?

## This is Just Map/Reduce

This formulation is one of many possible.
Arguably it's not even a very good one, but I'll leave shortcomings
and improvements as an exercise.

If you crack open a database query planner,
this is what its gooey center looks like -- though perhaps a bit
more inscrutable and less tuneable.
Databases use internal states like RoomState all the time,
as an internal result
built in service of the result that you actually asked for.

What's salient is we've deconstructed the hard question of
"how should a Message or RoomUser update user's `numUnreadRooms`?"
into a bunch of simpler questions:

  * **(A)** How should a Message or RoomUser be shuffled to its current RoomState?
  * **(B)** How do I turn that Message or RoomUser _into_ a RoomState?
  * **(C)** Given a current RoomState, how do I reduce in an update to produce a *next* state?
  * **(D)** Given previous and next states, which users toggled between having seen the room ?
  * **(E)** Given the set of toggles of each user, what's their current `numUnreadRooms`?

_Lots_ of problems can be tackled by this kind of destructuring
and the general shapes tend to be really similar:

  * Shuffling a document on an extracted key.
  * Mapping a document into another kind of document.
  * Combining or reducing two documents into one.
  * Mapping a document, as well as *before* and *after* internal states, into other documents.
  * Recursively shuffling, mapping, or reducing *those* documents in further, cascaded steps.

## Flow As Continuous Map/Reduce

Flow lets you express map/reduce workflows in declarative terms:
YAML definitions and associated pure-function lambdas.
You *apply* specifications to the Flow runtime
which executes them continuously, at any scale, driven by your writes,
with end-to-end "exactly once" semantics.

Specifications are succinct but don't sacrifice fidelity
to the various shapes these kinds of workflows can take
-- as simple as possible but no simpler.

If you're familiar with traditional database architecture,
you'll notice a bit of a theme:
internal database details are often first-class citizens within Flow.
This is of a piece with Flow's broader vision of
[un-bundling the database](https://www.confluent.io/blog/turning-the-database-inside-out-with-apache-samza/)
 -- without forsaking the properties that make databases desirable in the first place!

Internal states are no exception.
Flow calls these
[registers](https://docs.estuary.dev/concepts/catalog-entities/derivations#registers):
keyed documents used for indexed states like RoomState.
Registers enable the full gamut of stateful streaming workflows,
including joins and aggregations.
They're fast, persistent,
and aren't beholden to the windowing and scaling constraints
that plague other streaming workflow engines.

Writing reducers can be verbose and error-prone, so with Flow **you don't write them**.
Instead you annotate your schemas with
[`reduce` annotations](https://docs.estuary.dev/reference/catalog-reference/schemas-and-data-reductions#reductions)
that tell Flow how to combine documents having the same key.
This is another inversion from a database:
SQL functions like `SUM` imply reduction under the hood,
but Flow hoists reduction to a top-level schema concern.

In fact of **(A-E)** above, only **(B)** and **(D)** require any code:
You provide Flow with pure functions that map documents into other
documents.
Today Flow requires that these mappers be provided as strongly-typed TypeScript,
or as a remote JSON HTTP lambda. In the future we'll add support for WebAssembly.

---

Putting this all together, here's the workflow as a
derived collection and
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

  1) The derivation shuffles each Message or RoomUser to a corresponding
  RoomState register on `/roomId`.

  2) It calls an `update`
  [TypeScript lambda](https://github.com/jgraettinger/filling-paradigm-shaped-hole/blob/master/userDetails.flow.ts)
  to map the source document into a RoomState.

  3) It uses `reduce` schema annotations to fold the update into the current register.

  4) It calls the `publish` lambda with *before* and *after* versions of the RoomState
    (and also the source document, which we don't need here).

  5) The lambda identifies users who have toggled between rooms,
  and returns documents like `{"id":"johnny","numUnseenRooms":"-1"}`.

  6) Returned documents are checked against the collection schema,
  they're potentially combined on `/id` (the collection key),
  and they're written out to the collection.

Finally `userDetails` is materialized to a table:
```yaml
materializations:
  - endpoint:
      name: demo/database
      config: { table: user_details }
    source: { name: userDetails }
```

Materializations are always in terms of the collection's key.
The schema annotates that `numUnreadRooms` is reduced as a sum,
so Flow maintains the running lifetime tally.
Storage for the materialization is provided by the database.
Flow reads, modifies, and writes documents as needed:

![Animation of Materialization](./images/materialization.gif)

## How this Helps

What we've achieved is a de-normalized view, in our database of choice,
that's reactive to our normalized business events, past and future.
It's consolidated into a single place, strongly-typed, tested,
and completely isolated from our application code.
Flow will manage its execution for us and we don't have yet another app to deploy.

The solution isn't *completely* declarative —
we still had to write a non-trivial
pure function to identify users that changed between room states —
but we've substantially simplified from the spaghetti of per-event application handlers.

From here we're able to evolve the derivation over time,
or compose it as an input of other derivations.
We can add a materialization into another system,
perhaps to migrate it into a key/value store.

## On Query Planners

It's not entirely lost on me that Liron asked for easy de-normalized views
and I've offered up a moderately complex continuous map/reduce workflow.

Why not, for example, apply a query planner that turns a higher-level
language like SQL into an *internal execution plan* using something
like derivations and registers?

The short answer is that a query-planner *first* approach is
incompatible with Flow's broader objectives:
composable, straightforward
and succinct expressions of complex and long-lived workflows,
which are production-ready and integrate into the places you need them.
For example:

  * The details of the query plan (e.x. derivations and registers) *really* matter,
    particularly for workflows running at scale for months or years.
    You have to understand their operational aspects,
    and planners often get in the way of an engineer who knows what they want.

  * You'll need to evolve workflows over time —
    joining in a new data set,
    enriching with extra fields, or fixing a bug —
    and you may not appreciate being forced to
    recompute from piles of historical data (expensive!)
    Derivations allow for such changes today, but it's unclear how a planner could.

  * One team's output is another team's input, and
    you'll want to re-use derivations in many data products.
    The structure and overall optimization of the execution graph
    is more important than the plan of a single query.

  * Flow derivations allow for general computation:
    TypeScript, remote lambdas, and (in the future) WebAssembly.
    It's unclear how that flexibility would be incorporated into plans.
  
In truth this stuff is *hard* and trade-offs abound.
Flow threads the needle today by exposing its fundamental
operations as first-class primitives,
with the hope and expectation that, in the future,
one or more query planners could be
layered on to generate execution graphs *in terms* of these
primitives — an area we'll explore going forward.
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