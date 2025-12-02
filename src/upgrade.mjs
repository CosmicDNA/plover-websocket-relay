/**
 * Checks for the 'Upgrade: websocket' header on a standard Request object.
 * @param {Request} request The incoming request object.
 * @returns {Response | undefined} A 426 Response if the header is missing, otherwise undefined.
 */
const upgrade = (request) => {
  // DEBUG: Log all headers
  console.log('[MAIN Worker upgrade()] Incoming request headers:');
  for (const [key, value] of request.headers.entries()) {
    console.log(`  ${key}: ${value}`);
  }

  const upgradeHeader = request.headers.get('Upgrade');
  console.log(`[MAIN Worker upgrade()] Upgrade header value: "${upgradeHeader}"`);

  if (upgradeHeader !== 'websocket') {
    console.error('[MAIN Worker upgrade()] Missing or invalid Upgrade header. Returning 426.');
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }
  console.log('[MAIN Worker upgrade()] Upgrade header valid. Proceeding.');
}

export default upgrade