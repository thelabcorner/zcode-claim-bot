export async function getPageTargets(port = 9333) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  return list.filter(t => t.type === 'page');
}

export async function evalInPage(port, expression, { timeoutMs = 30000 } = {}) {
  const targets = await getPageTargets(port);
  const page = targets[0];
  if (!page) throw new Error('no page target on :' + port);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws open failed')); });
  const id = Math.floor(Math.random() * 1e9);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('cdp timeout')); }, timeoutMs);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) return reject(new Error(msg.error.message));
      const r = msg.result;
      if (r.exceptionDetails) return reject(new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)));
      resolve(r.result.value);
    };
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}
