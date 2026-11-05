/*
 * Copyright The Athenz Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const userService = require('../services/userService');

const GROUP_LOOKUP_INTERVAL_MS = 100;
const MAX_CONCURRENT_GROUP_LOOKUPS = 4;
const MAX_RATE_LIMIT_RETRIES = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Share the schedule across requests in this UI process. ZMS sees these
// requests from the same UI instance, even when different users open a page.
function createPacedQueue(intervalMs, maxConcurrent) {
    const pending = [];
    let active = 0;
    let nextStart = 0;
    let timer = null;

    function drain() {
        if (timer || active >= maxConcurrent || pending.length === 0) {
            return;
        }

        const wait = Math.max(0, nextStart - Date.now());
        if (wait > 0) {
            timer = setTimeout(() => {
                timer = null;
                drain();
            }, wait);
            return;
        }

        const { run, resolve, reject } = pending.shift();
        active++;
        nextStart = Date.now() + intervalMs;
        Promise.resolve()
            .then(run)
            .then(resolve, reject)
            .finally(() => {
                active--;
                drain();
            });
        drain();
    }

    const schedule = (run) =>
        new Promise((resolve, reject) => {
            pending.push({ run, resolve, reject });
            drain();
        });

    schedule.pause = (ms) => {
        nextStart = Math.max(nextStart, Date.now() + ms);
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        drain();
    };

    return schedule;
}

const scheduleGroupLookup = createPacedQueue(
    GROUP_LOOKUP_INTERVAL_MS,
    MAX_CONCURRENT_GROUP_LOOKUPS
);

function readGroup(req, domainName, groupName) {
    return new Promise((resolve, reject) => {
        req.clients.zms.getGroup({ domainName, groupName }, (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    });
}

async function readGroupWithRetry(req, domainName, groupName, schedule, wait) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await schedule(() => readGroup(req, domainName, groupName));
        } catch (err) {
            if (err.status === 404) {
                return null;
            }
            if (err.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) {
                throw err;
            }
            const backoff = 250 * 2 ** attempt;
            if (schedule.pause) {
                schedule.pause(backoff);
            }
            await wait(backoff);
        }
    }
}

async function enrichRoleGroupMembers(
    req,
    roleMembers,
    schedule = scheduleGroupLookup,
    wait = sleep
) {
    const groupMembersByName = new Map();

    for (const member of roleMembers) {
        member.memberFullName = userService.getUserFullName(member.memberName);
        if (member.memberName.includes(':group.')) {
            const [domainName, groupName] = member.memberName.split(':group.');
            const key = `${domainName}:group.${groupName}`;
            if (!groupMembersByName.has(key)) {
                groupMembersByName.set(key, {
                    domainName,
                    groupName,
                    roleMembers: [],
                });
            }
            groupMembersByName.get(key).roleMembers.push(member);
        }
    }

    await Promise.all(
        [...groupMembersByName.values()].map(async (group) => {
            let data;
            try {
                data = await readGroupWithRetry(
                    req,
                    group.domainName,
                    group.groupName,
                    schedule,
                    wait
                );
            } catch (err) {
                console.warn('Failed to load role group members', {
                    domainName: group.domainName,
                    groupName: group.groupName,
                    status: err.status,
                });
                throw err;
            }
            if (data && data.groupMembers) {
                const groupMembers = data.groupMembers.map((member) => ({
                    ...member,
                    memberFullName: userService.getUserFullName(
                        member.memberName
                    ),
                }));
                group.roleMembers.forEach((member) => {
                    member.groupMembers = groupMembers;
                });
            }
        })
    );
}

module.exports = { enrichRoleGroupMembers, createPacedQueue };
