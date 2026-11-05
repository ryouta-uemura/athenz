const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');

const uiRoot = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(uiRoot, 'package.json'))) {
    console.error('Usage: node real-ui-server.cjs /path/to/athenz/ui');
    process.exit(1);
}

process.chdir(uiRoot);
// Match `next dev` on macOS so two demo instances fit the OS watcher limit.
process.env.WATCHPACK_WATCHER_LIMIT ||= '20';
const uiRequire = createRequire(path.join(uiRoot, 'package.json'));
const clients = uiRequire('./src/server/clients');
const api = uiRequire('./src/server/handlers/api');
const nextFromUi = uiRequire('next');
const expressFromUi = uiRequire('express');

const domainSizes = new Map([
    ['domain-with-50', 50],
    ['domain-with-100', 100],
    ['domain-with-155', 155],
]);

function roleFor(domainName) {
    const size = domainSizes.get(domainName);
    if (!size) return null;
    return {
        name: `${domainName}:role.users`,
        roleMembers: Array.from({ length: size }, (_, index) => ({
            memberName: `${domainName}:group.team-${String(index + 1).padStart(3, '0')}`,
            approved: true,
        })),
        auditLog: [],
    };
}

function returnRole(params, callback) {
    const role = roleFor(params.domainName);
    if (!role || params.roleName !== 'users') {
        callback({ status: 404, message: 'Mock role not found' });
        return;
    }
    reset();
    respondWithRateLimit('getRole', role, callback);
}
let capacity = Number(process.env.DEMO_CAPACITY || 20);
let otherUsed = Number(process.env.DEMO_OTHER_USED || 2);
const instanceCount = 8;
let nextInstance = 0;
let buckets = null;
let stats = { getRole: 0, getGroup: 0, rejected: 0 };

function take(operation) {
    if (buckets === null) {
        buckets = Array.from({ length: instanceCount }, () => ({
            tokens: capacity - otherUsed,
            updatedAt: Date.now(),
        }));
    }
    stats[operation]++;
    const instance = nextInstance++ % instanceCount;
    const bucket = buckets[instance];
    const now = Date.now();
    bucket.tokens = Math.min(
        capacity,
        bucket.tokens + ((now - bucket.updatedAt) * 20) / 1000
    );
    bucket.updatedAt = now;
    if (bucket.tokens < 1) {
        stats.rejected++;
        return false;
    }
    bucket.tokens--;
    return true;
}

function respondWithRateLimit(operation, value, callback) {
    const allowed = take(operation);
    setTimeout(
        () =>
            allowed
                ? callback(null, value)
                : callback({ status: 429, message: 'Mock ZMS rate limit' }),
        operation === 'getGroup' ? 300 : 60
    );
}

function reset() {
    nextInstance = 0;
    buckets = null;
    stats = { getRole: 0, getGroup: 0, rejected: 0 };
}

const zms = new Proxy(
    {
        getRole: returnRole,
        getGroup: (params, callback) =>
            respondWithRateLimit(
                'getGroup',
                {
                    name: `${params.domainName}:group.${params.groupName}`,
                    groupMembers: [{ memberName: 'demo.user1' }],
                },
                callback
            ),
        getRoles: (params, callback) => {
            const role = roleFor(params.domainName);
            if (!role) {
                callback({ status: 404, message: 'Mock domain not found' });
                return;
            }
            const { auditLog, ...roleSummary } = role;
            callback(null, { list: [roleSummary] });
        },
        getDomainRoleMembers: (params, callback) =>
            callback(null, { members: [] }),
        getPendingDomainGroupMembersList: (params, callback) =>
            callback(null, { domainGroupMembersList: [] }),
        getPendingDomainRoleMembersList: (params, callback) =>
            callback(null, { domainRoleMembersList: [] }),
        getDomainTemplateList: (params, callback) =>
            callback(null, { templateNames: [] }),
        getDomain: (params, callback) =>
            callback(null, {
                name: params.domainName || params.domain,
                auditEnabled: false,
            }),
    },
    {
        get(target, property) {
            if (property in target) return target[property];
            return (...args) => {
                const callback = args[args.length - 1];
                if (typeof callback !== 'function') {
                    throw new Error(`Unmocked ZMS method: ${String(property)}`);
                }
                callback(null, { list: [], members: [], validValues: [] });
            };
        },
    }
);

clients.load = async () => {};
clients.middleware = () => (request, response, nextMiddleware) => {
    request.clients = { zms, zts: zms, msd: zms, ums: zms, cloud_sso: zms };
    nextMiddleware();
};

const config = {
    zms: 'mock://zms',
    userDomain: 'demo',
    userData: () => ({
        userMail: 'demo@example.invalid',
        userLink: { title: 'Demo user', url: '#', target: '_self' },
        userIcon: '',
    }),
    allPrefixes: [],
    headerLinks: [],
    allProviders: [],
    serviceHeaderLinks: [],
    servicePageConfig: {},
    pageFeatureFlag: {},
    featureFlag: false,
    timeZone: 'UTC',
    templates: [],
};

const port = Number(process.env.DEMO_PORT || 4180);
const nextApp = nextFromUi({ dev: true, webpack: true, dir: uiRoot, port });
nextApp.prepare().then(async () => {
    await api.load(config, {});
    const app = expressFromUi();
    app.use((request, response, nextMiddleware) => {
        request.session = { shortId: 'demo-user', email: 'demo@example.invalid' };
        request.csrfToken = () => 'demo';
        request.headers.rid = 'demo';
        response.locals.nonce = 'demo';
        nextMiddleware();
    });
    app.use((request, response, nextMiddleware) => {
        if (request.path.startsWith('/api/v1/')) {
            response.setHeader('Cache-Control', 'no-store');
            const resource = request.path.slice('/api/v1/'.length).split(';')[0];
            response.on('finish', () =>
                console.log(`UI API ${resource}: ${response.statusCode}`)
            );
        }
        nextMiddleware();
    });
    app.get('/__demo/stats', (request, response) =>
        response.json({ ...stats, capacity, otherUsed })
    );
    app.get('/__demo/reset', (request, response) => {
        const requestedCapacity = Number(
            request.query.capacity === undefined
                ? capacity
                : request.query.capacity
        );
        const requestedOtherUsed = Number(
            request.query.otherUsed === undefined
                ? otherUsed
                : request.query.otherUsed
        );
        if (
            !Number.isInteger(requestedCapacity) ||
            requestedCapacity < 1 ||
            requestedCapacity > 1000 ||
            !Number.isInteger(requestedOtherUsed) ||
            requestedOtherUsed < 0 ||
            requestedOtherUsed >= requestedCapacity
        ) {
            return response.status(400).json({ error: 'Invalid capacity or otherUsed' });
        }
        capacity = requestedCapacity;
        otherUsed = requestedOtherUsed;
        reset();
        response.json({ ...stats, capacity, otherUsed });
    });
    api.route(app);
    app.all('*', (request, response) => nextApp.getRequestHandler()(request, response));
    app.listen(port, '127.0.0.1', () => {
        console.log(`Real UI mock: http://127.0.0.1:${port}`);
        console.log(`UI root: ${uiRoot}`);
        console.log(`Demo domains: ${[...domainSizes.keys()].join(', ')}`);
    });
});
