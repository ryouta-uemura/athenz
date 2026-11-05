import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const groupsFile = join(here, 'groups.json');
const syntheticGroups = Array.from(
    { length: 155 },
    (_, index) => `demo.domain${String(index + 1).padStart(3, '0')}:group.team`
);

function loadGroups() {
    if (!existsSync(groupsFile)) {
        return { names: syntheticGroups, source: 'synthetic' };
    }
    const names = JSON.parse(readFileSync(groupsFile, 'utf8'));
    if (
        !Array.isArray(names) ||
        names.length === 0 ||
        !names.every(
            (name) =>
                typeof name === 'string' &&
                name.includes(':group.') &&
                name.length < 256
        )
    ) {
        throw new Error('groups.json must be a nonempty array of group names');
    }
    return { names, source: 'local group-name export' };
}

const { names: groups, source } = loadGroups();
const capacity = 20;
const refillPerSecond = 20;
const instanceCount = 8;
const roleDelayMs = 80;
const groupDelayMs = 450;
let buckets;
let stats;
let nextInstance;

function reset(otherUsed) {
    buckets = Array.from({ length: instanceCount }, () => ({
        tokens: capacity - otherUsed,
        updatedAt: Date.now(),
    }));
    stats = {
        getRole: 0,
        getGroup: 0,
        rejected: 0,
        perInstance: Array.from({ length: instanceCount }, () => ({
            requests: 0,
            rejected: 0,
        })),
    };
    nextInstance = 0;
}

function takeToken(operation, forceReject = false) {
    const instance = nextInstance++ % instanceCount;
    const bucket = buckets[instance];
    const now = Date.now();
    bucket.tokens = Math.min(
        capacity,
        bucket.tokens + ((now - bucket.updatedAt) * refillPerSecond) / 1000
    );
    bucket.updatedAt = now;
    stats[operation]++;
    stats.perInstance[instance].requests++;
    const rejected = forceReject || bucket.tokens < 1;
    if (rejected) {
        stats.rejected++;
        stats.perInstance[instance].rejected++;
    } else {
        bucket.tokens--;
    }
    return rejected;
}

const delay = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

async function getRole() {
    const rejected = takeToken('getRole');
    await delay(roleDelayMs);
    if (rejected) {
        throw Object.assign(new Error('Mock ZMS rate limit exceeded'), {
            status: 429,
        });
    }
    return { name: 'shepherd.ws:role.users', groups };
}

async function getGroup(name, forceReject = false) {
    const rejected = takeToken('getGroup', forceReject);
    await delay(groupDelayMs);
    if (rejected) {
        throw Object.assign(new Error('Mock ZMS rate limit exceeded'), {
            status: 429,
        });
    }
    return {
        name,
        members: ['demo.user1', 'demo.user2'],
    };
}

function sendJson(response, status, data) {
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(data));
}

reset(2);

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (request.method !== 'GET') {
        return sendJson(response, 405, { error: 'Method not allowed' });
    }
    if (url.pathname === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return response.end(readFileSync(join(here, 'index.html')));
    }
    if (url.pathname === '/api/config') {
        return sendJson(response, 200, {
            source,
            groupCount: groups.length,
            capacity,
            refillPerSecond,
            instanceCount,
        });
    }
    if (url.pathname === '/api/role') {
        const mode = url.searchParams.get('mode');
        if (mode !== 'as-is' && mode !== 'to-be') {
            return sendJson(response, 400, { error: 'Invalid mode' });
        }
        const otherUsed = Number(url.searchParams.get('otherUsed') ?? '2');
        if (!Number.isInteger(otherUsed) || otherUsed < 0 || otherUsed > 19) {
            return sendJson(response, 400, { error: 'otherUsed must be 0–19' });
        }
        reset(otherUsed);
        try {
            const role = await getRole();
            if (mode === 'as-is') {
                // Mirrors the old role.read fan-out: every referenced group is
                // requested before the role response can be returned.
                const details = await Promise.all(
                    role.groups.map((name) => getGroup(name))
                );
                return sendJson(response, 200, { ...role, details, stats });
            }
            // Mirrors the fixed role.read path: return role references only.
            return sendJson(response, 200, { ...role, stats });
        } catch (error) {
            return sendJson(response, error.status ?? 500, {
                error: error.message,
                stats,
            });
        }
    }
    if (url.pathname === '/api/group') {
        const name = url.searchParams.get('name');
        if (!groups.includes(name)) {
            return sendJson(response, 404, { error: 'Unknown group' });
        }
        try {
            const group = await getGroup(
                name,
                url.searchParams.get('fail') === '1'
            );
            return sendJson(response, 200, { group, stats });
        } catch (error) {
            return sendJson(response, error.status ?? 500, {
                error: error.message,
                stats,
            });
        }
    }
    return sendJson(response, 404, { error: 'Not found' });
});

const port = Number(process.env.DEMO_PORT || 4177);
server.listen(port, '127.0.0.1', () => {
    console.log(`Demo: http://127.0.0.1:${port}`);
    console.log(`Group data: ${source} (${groups.length} references)`);
});
