# Event Streaming Like it's 1978

Imagine you're a bank. You have a bunch of accounts.
Those accounts want to transfer money with each other,
and to a special "sweep" account for bank deposits and withdrawals. 
Transfers happen all the time, and you want to quickly figure out
if the sender has sufficient funds for the transfer to go through.
And of course once you approve a transfer,
you've got to debit the sender
so they can't send those funds again.

I want to show you a state of the art,
transactional stream processor
you should consider for tackling this problem.

Ready? Here goes:

```python
import sys
import os
import jsonlines
import orjson

balances = {}  # Current account balances.

# Example input: {"source":"alice", "target":"bob", "amount": 25.32}
for transfer in jsonlines.Reader(sys.stdin, loads=orjson.loads):
    src, tgt, amount = transfer["source"], transfer["target"], transfer["amount"]

    if src == "sweep" or balances.get(src, 0) >= amount:
        balances[src] = balances.get(src, 0) - amount
        balances[tgt] = balances.get(tgt, 0) + amount
        transfer["outcome"] = "approve"
    else:
        transfer["outcome"] = "deny"

    # Example output: {"source":"alice", "target":"bob", "amount": 25.32, "outcome": "deny"}
    os.write(1, orjson.dumps(transfer, option=orjson.OPT_APPEND_NEWLINE))
```

Vanilla Python.
I know, right?
Not known for being the most performant of languages.

Just for fun, let's work up a quick benchmark and...

```console
$ time (for _ in {1..10000}; do cat bench_1k.input ; done) | python3 transfers.py > /dev/null

real    0m19.266s
user    0m23.682s
sys     0m3.016s

$ python3
>>> (1_000 * 10_000) / 19.266
519049.1020450535
```

... 🤯 _what_??

_This thing is pushing **half a million** transactions per second_.
On a single core.

Just for context,
the _entire VISA network_ supports
[~25K peak transactions per second](https://www.reddit.com/r/nanocurrency/comments/82438o/visa_is_capable_of_performing_24000_transactions/).
Clearly twenty lines of Python doesn't make a Fortune 500 company,
but my point is simply that concise expressions of
business transaction logic can be really, _really_ fast.

Read JSON from standard input.
Update some memory.
Make a decision.
Write JSON to standard output.
That's it.

## Unix Philosophy

We've known it's a good idea to build programs like this
for over four decades now.
The
"[Unix Philosophy](https://en.wikipedia.org/wiki/Unix_philosophy)"
was first penned in 1978 by Doug McIlroy,
and even then it was an old idea.
That memo was a write-up of tribal knowledge acquired since the
invention of pipes for wiring programs together _back in 1964_.

> This is the Unix philosophy: Write programs that do one thing and do it well. Write programs to work together. Write programs to handle text streams, because that is a universal interface. - Doug McIlroy

In 2021, this philosophy is still wildly successful.
We apply it daily with every launched terminal
and command-line invocation.
It's fundamental.

_We should want to build production dataflows in the same way._

If you squint a bit,
modern pub/sub systems look an awful lot like Unix pipes.
Could we plug regular programs in between,
consuming from and feeding back into those pipes?

I'm not the first to point out that this seems like a good idea.
[Martin Kleppman](https://www.oreilly.com/library/view/making-sense-of/9781492042563/ch04.html)
has been preaching this gospel for years.
But aside from the most simplistic of use cases,
**you just can't**.

## It's 2021 and You Still Can't Have This

Well, you can _sort of_ apply the Unix philosophy by wiring up
Kinesis or Kafka to pipe inputs and outputs of an AWS Lambda.

It has major caveats:
inputs may be mis-ordered or repeated,
making re-ordering and de-dup something
your application must handle.
You're responsible for updating outputs into your systems -
like database or key/value stores -
where those representations should live.
You will encounter scaling and correctness challenges due to
[data skews](https://dataengi.com/2019/02/06/spark-data-skew-problem/),
[write skews](https://en.wikipedia.org/wiki/Snapshot_isolation),
and per-event network latencies.

It's an **awful lot of coupling** between a few lines of business logic,
and all of the other runtime concerns required to serve
an application of this kind.

And of course, it can't support persistent in-memory states!
An internal state like the `balances` dictionary must
be externalized into a transactional store,
which will _clobber_ processing throughput.

Again, what you _want_ to do is:

1) Deploy an _unmodified_ instance of the Python app.
2) Connect it to a data source of transfer requests.
3) Connect its output into another app, or to a database, or both.

_How_ transfer requests are piped in,
or how its results are persisted somewhere,
is something you'd rather not have to think about in the app itself.
Hopefully a runtime
[like this one](https://github.com/estuary/flow)
could handle those details in a flexible way.

But you can't do this today.
Your next best option is to embrace one of the
Stream Processing Frameworks:
[Spark](https://spark.apache.org/docs/latest/streaming-programming-guide.html),
[Flink](https://flink.apache.org/),
[Kafka Streams](https://kafka.apache.org/documentation/streams/),
[Gazette Consumers](https://gazette.readthedocs.io/en/latest/consumers-concepts.html),
and still others.

Before getting into that, let's break down the assumptions
of our program to inform why "Stream Processing Frameworks"
are even a thing.

## Flaws in the Fault Model

Our program has a few expectations which are incompatible
with modern stream processing:

**Single input stream:**

We're reading from `stdin`.
There's only one of them,
and it provides an ordered sequence of inputs.

_Reality_: we may want to transform from multiple
distinct sequences of inputs,
like Kenesis or Kafka topics and partitions.

**Reliable input:**

We expect to read each input exactly-once,
and we assume the input stream can never fail.

_Reality_: streaming systems are typically at-least once -
meaning we could see a message more than one time -
and they fail all the time.

**Deterministic input:**

Our program has an interesting property:
if you feed it the same inputs in the same order,
it will make the same decisions every time.
Not every program is like this, but many are.
This is useful.
We can start the program over again,
this time with more inputs tacked onto the end,
and we'll get the same results. 

_Reality_: input orders are unpredictable when
reading across topics and partitions.
Systems are typically also _buffers_ and don't 
retain the full history of the stream.

**Runs Forever:**

If you can find a machine that will never fail
then you could run our program forever.
It would happily track account balances
and make transfer decisions for as long
as you care to feed it input.

_Reality_: machines fail all the time, at any time.
But we can't just pick up where we left off,
because `balances` depends on the _entire_ input sequence.
We need continuity of the process lifetime.

---

Another consideration in all this is scale-out of your
streaming operator.
I'll side-step this subject for now with just a couple of observation:
* The Unix philosophy isn't incompatible with scale-out.
* We could better utilize the resources we have before reaching for parallelism.

## Streaming Frameworks

Pick a framework,
like [Flink's](https://flink.apache.org/),
and map our program into it.

You certainly can. It's not impossible.
It's also not pleasant.
The framework throws a lot of concepts at you,
like state stores, checkpoints, and watermarks.

It's not even because they're jerks.
I've said that `balances` is a challenge:
it's a state variable that's tightly bound to
the specific inputs and outputs processed by the program.
The framework needs to know about it,
needs to track it,
and must produce recoverable checkpoints which include it.

And that's the core issue:
streaming frameworks ask that we adapt _our_ programs
to the realities of _their_ execution model.

Unfortunately they ask that we throw out the
Unix Philosophy along the way:

> Write programs that do one thing and do it well. 

Instead we write a few lines of core logic
wrapped in many more of boilerplate,
with an awkward state store interface
in place of a Python dictionary,
with hard-coded input and output sources & sinks,
and specific expectations of how the application
is deployed and scaled.

> Write programs to work together.

I mean, kinda?
You can at least get Flink, Spark,
et all talking over a pub/sub topic.

But the framework onboarding cost -
in learning curve,
project setup,
and required runtime infrastructure -
severely limits your practical flexibility.

> Write programs to handle text streams, because that is a universal interface

Sadly, no.

And we should _really_ want this.
Aside from the practical convenience,
it makes it possible to **test** unmodified programs
without knowing anything of their implementation.
Spin them up, throw inputs at them, and observe their outputs.

## Fixing the Fault Model

I'm thankful for what we, as an industry,
have been able to build and learn
from the streaming frameworks that we have.

But I think it's time to try something.
As I said, streaming frameworks ask that we adapt _our_
programs to the realities of _their_ fault model.

The question I want to answer is:
how can we build an execution environment
that meets the expectations of Unix Philosophy programs?
The problems of check-points,
internal states, sources, sinks, multiplexing, latency,
and crash recovery don't magically go away, of course.
But perhaps the runtime could provide an environment
that encapsulates those details.

It could, for example,
take incremental snapshots _of the entire program_
within its checkpoints,
giving our python script the **illusion** that it's
one long-running script when in actuality
it's handed off between physical machines over time.

That would let you take *any* program:
our python program,
or a Spark or Flink SQL query,
or Differential Dataflow,
or `jq` command,
or just about anything else
and run it in a _plugable_ way.

It would decouple the choice of dataflow implementation -
and the expression of our business logic -
from the gory details of how streaming systems need
to work in practice.

I believe it's possible. I'd like to find out.