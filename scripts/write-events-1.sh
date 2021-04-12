curl -f -H 'Content-Type: application/json' -d @/dev/stdin http://localhost:8080/ingest <<EOF
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