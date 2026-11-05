const cdpPort = Number(process.env.DEMO_CDP_PORT || 9223);
const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((r) => r.json());
const target = targets.find((item) => item.type === 'page');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
let callId = 0;
const pending = new Map();
const eventWaiters = new Map();
socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
    }
    const waiters = eventWaiters.get(message.method) || [];
    for (const resolve of waiters) resolve(message);
    eventWaiters.delete(message.method);
});
function send(method, params = {}) {
    const id = ++callId;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => pending.set(id, resolve));
}
function waitEvent(name) {
    return new Promise((resolve) => {
        eventWaiters.set(name, [...(eventWaiters.get(name) || []), resolve]);
    });
}
async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true });
    return result.result?.result?.value;
}
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });

async function measure(port, page, capacity, otherUsed = 0) {
    const base = `http://127.0.0.1:${port}`;
    await fetch(`${base}/__demo/reset?capacity=${capacity}&otherUsed=${otherUsed}`);
    const loaded = waitEvent('Page.loadEventFired');
    await send('Page.navigate', { url: `${base}${page}` });
    await loaded;
    let observation;
    const deadline = Date.now() + 15000;
    do {
        observation = await evaluate(`(() => ({
            elapsed: performance.now(),
            listRows: document.querySelectorAll('[data-testid="role-row"]').length,
            memberRows: document.querySelectorAll('[data-testid="member-row"]').length,
            error: document.body.innerText.includes('Mock ZMS rate limit'),
            roleApi: performance.getEntriesByType('resource')
                .filter(item => item.name.includes('/api/v1/role;'))
                .map(item => ({duration:item.duration, status:item.responseStatus}))
        }))()`);
        if (observation?.error || observation?.roleApi?.some((item) => item.status >= 400) || (page.endsWith('/role')
            ? observation?.listRows > 0
            : observation?.memberRows > 0)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    if (observation?.memberRows || observation?.listRows) {
        await new Promise((resolve) => setTimeout(resolve, 450));
        const settled = await evaluate(`({
            elapsed: performance.now(),
            error: document.body.innerText.includes('Mock ZMS rate limit'),
            listRows: document.querySelectorAll('[data-testid="role-row"]').length,
            memberRows: document.querySelectorAll('[data-testid="member-row"]').length,
            roleApi: performance.getEntriesByType('resource')
                .filter(item => item.name.includes('/api/v1/role;'))
                .map(item => ({duration:item.duration, status:item.responseStatus}))
        })`);
        if (settled?.error) observation = settled;
    }
    const stats = await fetch(`${base}/__demo/stats`).then((r) => r.json());
    return {
        version: port === 4180 ? 'fixed' : 'baseline',
        page: page.endsWith('/role') ? 'listing' : 'members',
        capacity,
        otherUsed,
        elapsedMs: Math.round(observation?.elapsed ?? -1),
        outcome: stats.rejected || observation?.error || observation?.roleApi?.some((item) => item.status >= 400) ? 'rate-limited' :
            (observation?.memberRows || observation?.listRows) ? 'rendered' : 'timeout',
        roleApiMs: observation?.roleApi?.map((x) => Math.round(x.duration)),
        getRole: stats.getRole,
        getGroup: stats.getGroup,
        rejected: stats.rejected,
    };
}

for (const size of [50, 100, 155]) {
    const domain = `domain-with-${size}`;
    const list = `/domain/${domain}/role`;
    const members = `/domain/${domain}/role/users/members`;
    for (const port of [4181, 4180]) {
        await measure(port, list, 20, 2);
        await measure(port, members, 20, 2);
    }
    for (let trial = 1; trial <= 3; trial++) {
        for (const port of [4181, 4180]) {
            for (const page of [list, members]) {
                const result = await measure(port, page, 20, 2);
                console.log(JSON.stringify({ trial, domain, ...result }));
            }
        }
    }
}
socket.close();
