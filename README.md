## Deployment

```bash
npm run deploy
```

## Test

### 🧪 Step 1: Test Your Deployed Worker
Before touching your existing code, verify the core logic works using command line tools.

1. Create a Session (Simulate Plover Plugin):

```bash
curl -s -X POST "$WORKER_URL/session/initiate" | tee session.json | jq
```
Expected Response: A JSON object with a protocol, sessionId, tabletConnectionToken and pcConnectionToken.

```json
{
  "protocol": "ws",
  "sessionId": "d7733ec2-248c-4574-bd68-875304d6f1db",
  "tabletConnectionToken": "c836995d4d9fdcb06bc298d2ccb4b6979758c177a5fa9c34b7477d23bcb27a56",
  "pcConnectionToken": "2c5e1e9449a1f15101361ed6d32af1562c26093c2d3843a97833eb0647c11151"
}
```

2. Connect as the PC (Simulate Plugin WebSocket):
Use a WebSocket client like wscat to connect as the PC.

```bash
# Construct the PC connection URL from the sessionId in the previous response
wscat -c "`jq -r .protocol session.json`://${WORKER_URL}/session/`jq -r .sessionId session.json`/connect?token=`jq -r .pcConnectionToken session.json`"
```

You should see a successful connection. The Worker logs will show PC connected to session.

Upon connecting, the PC client will receive a welcome message with its unique session ID:
`{"id":0,"type":"system","message":"Connection established","clientType":"pc"}`

3. Connect as the Tablet (Simulate React App):
In a second terminal, use the exact tabletConnectionUrl from Step 1.

```bash
wscat -c "`jq -r .protocol session.json`://${WORKER_URL}/session/`jq -r .sessionId session.json`/join?token=`jq -r .tabletConnectionToken session.json`"
```
Expected Results:

The tablet terminal will connect and receive its own welcome message with a unique ID:
`{"id":1,"type":"system","message":"Connection established","clientType":"tablet"}`

The PC terminal will automatically receive a notification that a new tablet has joined. This message includes the new tablet's ID and, crucially, a **new** `newTabletToken`. This new token must be used to connect any subsequent tablets, as the original `tabletConnectionToken` is now invalid.

```json
{
  "clientType":"tablet",
  "id":1,
  "type":"tablet_connected",
  "newTabletToken":"22b93a639b1eb0d5bf3f713d30c54841fe8a26fdf8a71c037d8cde13d9543424",
  "timestamp":1764964194099
}
```

### 🧪 Step 2: Test Message Relay & Close
With both clients connected, you can test the new private and public messaging system.

1. Send a Public Message from Tablet to PC:
In the tablet's terminal, send a message to all clients of type pc. The PC client (ID 0) will receive it, complete with the sender's information.

```bash
# In the tablet's wscat session:
{"to":{"type":"pc"},"payload":{"stroke":"KAT"}}
```
The PC terminal will receive: `{"stroke":"KAT","from":{"id":1,"type":"tablet"}}`

2. Send a Private Message from PC to Tablet:
In the PC's terminal, send a private message specifically to the tablet with ID 1.

```bash
# In the PC's wscat session:
{"to":{"type":"tablet","id":1},"payload":{"message":"Hello from PC!"}}
```
The tablet terminal will receive: `{"message":"Hello from PC!","from":{"id":0,"type":"pc"}}`

3. Get a List of Participants:
From any client, send a get_participants command.

```bash
# In any wscat session:
{"payload":{"command":"get_participants"}}
```

The client that sent the request will receive a list of all connected clients. For example:

```json
{"type":"participants_list","participants":[{"id":0,"type":"pc"},{"id":1,"type":"tablet"}]}
```

4. Close the Session: Send a close command from any connected client. This will terminate the entire session for all participants.

```bash
# In any wscat session:
{"payload":{"command":"close"}}
```

Both WebSocket connections should close immediately.

If all steps pass, your relay core is functioning perfectly.