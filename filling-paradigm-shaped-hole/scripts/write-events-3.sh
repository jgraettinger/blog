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