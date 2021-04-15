
## Addendum: Evolving UserDetails

TODO: this section would show how the running `userDetails` derivation
can be enriched by joining in real user names, without having to rebuild
from scratch.

**TODO stripped content to re-work into test cases:**

Sasha sends a new message,
but Mac re-thinks Giraffage and deletes their message
(schedule conflict 🤦).
Liron now hasn't read Sasha's latest in `r31`,
but they *have* seen `r20` since Mac deleted their unread message:

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

Liron deletes their chat with Sasha without seeing the last message,
and the deletion implicitly removes `r31` as an unread room.
They're still subscribed to `r20` but have seen its latest message:
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