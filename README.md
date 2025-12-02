## Deployment

```bash
npm run deploy
```

## Test

### 🧪 Step 1: Test Your Deployed Worker
Before touching your existing code, verify the core logic works using command line tools.

1. Create a Session (Simulate Plover Plugin):

```bash
curl -s -X POST "$WORKER_URL/session/initiate" | tee session.log | jq
```
Expected Response: A JSON object with a sessionId and a tabletConnectionUrl.

```json
{
  "sessionId": "2c16b810-6977-4806-a067-31465be1d6bc",
  "tabletConnectionUrl": "https://your-worker-name.your subdomain-name.workers.dev/session/2c16b810-6977-4806-a067-31465be1d6bc/join?token=06b7f9fa67e726ab699d83cf339cb68b7714b5a91f5239eab4ffb3fc161bb9b7"
}
```

2. Connect as the PC (Simulate Plugin WebSocket):
Use a WebSocket client like wscat to connect as the PC.

```bash
# Construct the PC connection URL from the sessionId in the previous response

# Format: wss://plover-websocket-relay.cosmicdna.workers.dev/session/<SESSION_ID>/connect

wscat -c "wss://$BASE_WORKER_URL/session/`jq -r .sessionId session.json`/connect"
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


```bash
curl -s -X POST "$WORKER_URL/session/initiate" | jq
```

You should then see a similar output to:

```json
{
  "sessionId": "2c16b810-6977-4806-a067-31465be1d6bc",
  "tabletConnectionUrl": "https://your-worker-name.your subdomain-name.workers.dev/session/2c16b810-6977-4806-a067-31465be1d6bc/join?token=06b7f9fa67e726ab699d83cf339cb68b7714b5a91f5239eab4ffb3fc161bb9b7"
}
```