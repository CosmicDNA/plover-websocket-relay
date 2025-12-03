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
Expected Response: A JSON object with a sessionId and a tabletConnectionUrl.

```json
{
  "sessionId": "1b99df0a-d703-4e79-9cd4-cad7c035226c",
  "tabletConnectionUrl": "ws://localhost:8787/session/1b99df0a-d703-4e79-9cd4-cad7c035226c/join?token=8601c575cc1094081961c692159d55f8051a0159fb2ab869b6cb1ac6c37e49c6"
}
```

2. Connect as the PC (Simulate Plugin WebSocket):
Use a WebSocket client like wscat to connect as the PC.

```bash
# Construct the PC connection URL from the sessionId in the previous response
wscat -c "${WORKER_PROTOCOL}://${WORKER_URL}/session/`jq -r .sessionId session.json`/connect"
```

You should see a successful connection. The Worker logs will show PC connected to session.

3. Connect as the Tablet (Simulate React App):
In a second terminal, use the exact tabletConnectionUrl from Step 1.

```bash
wscat -c `jq -r .tabletConnectionUrl session.json`
```
Expected Result:

The tablet terminal should connect successfully.

The PC terminal should automatically receive a {"type":"tablet_connected"} message.

The Worker logs will show Tablet connected to session.

Test Message Relay & Close:

Send a JSON message from the PC terminal: {"stroke": "KAT"}

It should appear in the tablet terminal.

Send {"type": "close"} from the tablet terminal. Both WebSocket connections should close.

If all steps pass, your relay core is functioning perfectly.