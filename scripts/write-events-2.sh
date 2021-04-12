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