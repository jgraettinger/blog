(This repo is being developed for a work-in-progress blog post:)

# Filling a Paradigm-Shaped Hole

👋 Hi, I'm Johnny, I work at [Estuary](https://estuary.dev) on our product "Flow".
[Flow](https://docs.estuary.dev) is a GitOps tool for integrating all of the systems
you use to produce, process, and consume data.
Today I want to talk about how Flow can help maintain complex materialized views
in your database(s) of choice.

## A Problem

This post is a response to Liron Shapira's excellent "[Data Denormalization is Broken][1]".
Liron details the subtleties of a seemingly "simple" messaging application that models
messages and user-to-room subscriptions.
The app requires a query-centric index for fast loads and good user experience,
but Liron laments the difficulty of actually maintaining views like this.
He concludes (emphasis mine):

> Right now, working with denormalized data is **bad**. If you’ve ever written
> anything less than the perfect denormalized-field recomputation code,
> then running it will have introduced data corruptions. Just like that,
> you’ve silently nuked the logical invariant that you were hoping to maintain
> on your data set. Don’t you wish that were impossible? Our current approach
> to denormalization has a **paradigm-shaped hole**.

[1]: https://lironshapira.medium.com/data-denormalization-is-broken-7b697352f405

What we're after today - as posed by Liron - is a read-centric materialized "user details" view.
It should index on user ID and maintain the current number of unread chat rooms by-user.
The view updates with new events and must account for:
 * Messages being sent and users viewing messages.
 * Messages being deleted.
 * Users deleting room subscriptions.
 * Users *un*-seeing chat rooms by restoring an older `seenTimestamp`.
 * Message timestamps moving forward or backward in time.

## A Demonstration

*Follow along from [this Git repository](https://github.com/jgraettinger/filling-paradigm-shaped-hole). Try it
in your browser using [GitHub CodeSpaces](https://github.com/features/codespaces):*

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

Our desired view can be implemented as a single Flow
[derivation](https://docs.estuary.dev/concepts/catalog-entities/derivations).
We'll look at its definition a bit later: first let's see it in action.
Start a local development instance of Flow:
```console
$ flowctl develop --source userDetails.flow.yaml
```

Then ingest the examples from Liron's post:
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

As expected, user `liron-shapira` now has two unread rooms:
```console
$ psql -h localhost -c 'SELECT id, numUnreadRooms FROM user_details;'
      id       | numunreadrooms 
---------------+----------------
 liron-shapira |              2
(1 row)
```

This PostgreSQL table was created for us by `flowctl develop` on startup,
drawn from our declared
[materialization](https://docs.estuary.dev/concepts/catalog-entities/materialization)
and its JSON schema.
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

Suppose Liron sees Sasha's latest message and Mac's first message, but not their second.
Chat room `r31` is now fully read, but `r20` has one remaining unread message:

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
`r31` is unread again, but `r20` is now read due to the message deletion:

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
`r31` is implicitly read due to its deletion.
`r20` remains an active and fully read subscription:
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

## An Implementation Sketch

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

This structure is handy, as it provides a self-contained answer as
to whether any subscriber has "seen" the room:
just take the maximum timestamp across all messages
and compare against the `seenTimestamp` of each subscriber.

There can be many chat rooms, so we'll need many RoomStates.
Every Message or RoomUser message can be mapped ("shuffled") to its corresponding
RoomState through its `/roomId`.

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
`{"userId":"johnny", "seenTimestamp": 0}` would toggle from "seen" to "not seen".

Each of these identified toggles contributes an `-1` or `+1` update to the user's `numUnreadRooms`.
If we kept track of all of these contributions, then all that would remain is to maintain a
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
  * **(E)** Given a running tally of toggles for each user, what's their current `numUnreadRooms`?

_Lots_ of problems can be tackled by this kind of destructuring,
and the general shapes of these steps tend to be really similar from problem to problem:

  * Shuffling a document on an extracted key.
  * Mapping a document into another kind of document.
  * Combining or reducing many documents into one.
  * Mapping a document, as well as *before* and *after* internal states, into other kinds of documents.
  * Recursively shuffling and mapping *those* documents in further, cascaded steps.

## Flow Derivations As Continuous Map/Reduce

Flow is designed to make it as easy as possible to express workflows of this kind,
and to then execute those workflows continuously, at any scale, as quickly as possible.

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
of your JSON schemas tell Flow how two document instances should be combined or reduced.

In fact of **(A-E)** above, only **(B)** requires any code: We must provide Flow with
pure function "mappers" that turn documents into other kinds of documents.
Today Flow requires that these mappers be provided as strongly-typed TypeScript,
or as a remote JSON HTTP lambda. In the future we'll add support for WebAssembly.

---

Putting it all together we can implement the workflow with a single derived collection and
schema **TODO link**: 
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

It calls the "update" TypeScript lambda **TODO insert link** to map source documents
into a RoomState, which are then reduced into the current register value.

These *before* and *after* RoomStates are then presented to the "publish" lambda,
which inspects them to identify users who have toggled between rooms,
and in turn publishes `userDetails` documents like `{"id":"johnny","numUnseenRooms":"-1"}`.

Finally, `userDetails` is materialized to a PostgreSQL table
where `numUnreadRooms` is reduced in a continuous running tally:
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

The solution isn't *completely* declarative -- we still have a non-trivial
function to identify users which changed between "seen" vs "not seen" room states --
but we've substantially simplified from the spaghetti of per-event application handlers.

## On Query Planners

It's not entirely lost on me that Liron asked for easy de-normalized views
and I've offered up a moderately complex continuous map/reduce workflow.

Why not, for example, apply a query planner that turns a higher-level
language like SQL into an *internal implementation* using something
like derivations and registers?

The short answer is that a query-planner **first** approach appears
incompatible with Flow's broader objectives:
composable, straightforward
and succinct expressions of complex and long-lived workflows,
which are production-ready and integrated into the places you need them.

For example:

  * The details of the query plan (e.x. derivations and registers) *really* matter,
    particularly for long-lived workflows run at scale.
    It's unavoidable that owners understand their operational aspects,
    and planners often get in the way of an engineer who knows what they want.

  * Workflows must evolve over time -- joining to a new data set,
    enriching with extra fields, or fixing a bug -- without being forced to
    recompute from scratch ($$$). Derivations allow for such changes today,
    but it's unclear how a planner could.

  * One team's output is often another team's input, and
    derivations may be re-used in many data products.
    Optimizing the overall structure of the execution graph is often
    more important than the plan of a single query.

  * Flow derivations allow for general computation:
    TypeScript, remote lambdas, and (in the future) WebAssembly.
    It's unclear how that flexibility would be incorporated into plans.

In truth this stuff is *hard* and trade-offs abound.
Flow threads the needle today by exposing its fundamental operations as first-class primitives,
with the hope and expectation that, in the future, one or more query planners could be
layered on top to *generate* execution graphs in terms of these
primitives -- an area we'll explore going forward.

## Addendum: Evolving UserDetails

TODO: this section would show how the running `userDetails` derivation
can be enriched by joining in real user names, without having to rebuild
from scratch.
