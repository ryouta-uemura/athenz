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

jest.mock('../../../server/services/userService', () => ({
    getUserFullName: (name) => `Full ${name}`,
}));

const {
    createPacedQueue,
    enrichRoleGroupMembers,
} = require('../../../server/utils/roleGroupMembers');

describe('role group member enrichment', () => {
    const scheduleImmediately = (run) => run();
    const waitImmediately = async () => {};

    it('fetches each distinct group once and preserves its members', async () => {
        const getGroup = jest.fn((params, callback) =>
            callback(null, {
                groupMembers: [{ memberName: 'user.alice' }],
            })
        );
        const roleMembers = [
            { memberName: 'other:group.engineers' },
            { memberName: 'other:group.engineers' },
            { memberName: 'user.bob' },
        ];

        await enrichRoleGroupMembers(
            { clients: { zms: { getGroup } } },
            roleMembers,
            scheduleImmediately,
            waitImmediately
        );

        expect(getGroup).toHaveBeenCalledTimes(1);
        expect(getGroup).toHaveBeenCalledWith(
            { domainName: 'other', groupName: 'engineers' },
            expect.any(Function)
        );
        expect(roleMembers[0].groupMembers).toEqual([
            { memberName: 'user.alice', memberFullName: 'Full user.alice' },
        ]);
        expect(roleMembers[1].groupMembers).toEqual(roleMembers[0].groupMembers);
        expect(roleMembers[2].memberFullName).toBe('Full user.bob');
    });

    it('retries 429 and still ignores missing groups', async () => {
        let engineerAttempts = 0;
        const getGroup = jest.fn((params, callback) => {
            if (params.groupName === 'missing') {
                return callback({ status: 404 });
            }
            engineerAttempts++;
            return engineerAttempts === 1
                ? callback({ status: 429 })
                : callback(null, { groupMembers: [] });
        });
        const roleMembers = [
            { memberName: 'other:group.engineers' },
            { memberName: 'other:group.missing' },
        ];
        const waits = [];

        await enrichRoleGroupMembers(
            { clients: { zms: { getGroup } } },
            roleMembers,
            scheduleImmediately,
            async (ms) => waits.push(ms)
        );

        expect(getGroup).toHaveBeenCalledTimes(3);
        expect(waits).toEqual([250]);
        expect(roleMembers[0].groupMembers).toEqual([]);
        expect(roleMembers[1].groupMembers).toBeUndefined();
    });

    it('returns a persistent 429 instead of claiming a group is empty', async () => {
        const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const getGroup = jest.fn((params, callback) =>
            callback({ status: 429 })
        );
        const roleMembers = [{ memberName: 'other:group.engineers' }];

        try {
            await expect(
                enrichRoleGroupMembers(
                    { clients: { zms: { getGroup } } },
                    roleMembers,
                    scheduleImmediately,
                    waitImmediately
                )
            ).rejects.toMatchObject({ status: 429 });
            expect(getGroup).toHaveBeenCalledTimes(4);
            expect(roleMembers[0].groupMembers).toBeUndefined();
        } finally {
            warning.mockRestore();
        }
    });

    it('spaces requests and pauses the queue after rate limiting', async () => {
        jest.useFakeTimers();
        try {
            const schedule = createPacedQueue(100, 4);
            const started = jest.fn();
            const calls = [
                schedule(() => started()),
                schedule(() => started()),
                schedule(() => started()),
            ];

            await jest.advanceTimersByTimeAsync(0);
            expect(started).toHaveBeenCalledTimes(1);
            schedule.pause(250);
            await jest.advanceTimersByTimeAsync(100);
            expect(started).toHaveBeenCalledTimes(1);
            await jest.advanceTimersByTimeAsync(150);
            expect(started).toHaveBeenCalledTimes(2);
            await jest.advanceTimersByTimeAsync(100);
            await Promise.all(calls);
            expect(started).toHaveBeenCalledTimes(3);
        } finally {
            jest.useRealTimers();
        }
    });
});
