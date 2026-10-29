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
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import GroupMemberList from '../../../components/member/GroupMemberList';
import API from '../../../api';

jest.mock('next/router', () => ({ withRouter: (Component) => Component }));
jest.mock('../../../api', () => jest.fn());

const props = {
    groupName: 'shepherd.ws:group.developers',
    router: { push: jest.fn() },
};

describe('GroupMemberList', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('loads members only when mounted', async () => {
        const getGroup = jest.fn().mockResolvedValue({
            groupMembers: [{ memberName: 'user.alice' }],
        });
        API.mockReturnValue({ getGroup });

        expect(getGroup).not.toHaveBeenCalled();
        render(<GroupMemberList {...props} />);

        expect(getGroup).toHaveBeenCalledWith(
            'shepherd.ws',
            'developers',
            false,
            false
        );
        expect(await screen.findByText('user.alice')).toBeInTheDocument();
    });

    it('shows a failure and retries without treating it as an empty group', async () => {
        const getGroup = jest
            .fn()
            .mockRejectedValueOnce({ status: 429 })
            .mockResolvedValueOnce({ groupMembers: [] });
        API.mockReturnValue({ getGroup });
        render(<GroupMemberList {...props} />);

        expect(
            await screen.findByText('Unable to load group members.')
        ).toBeInTheDocument();
        expect(screen.queryByText('No members in group.')).toBeNull();
        fireEvent.click(screen.getByText('Retry'));
        await waitFor(() => expect(getGroup).toHaveBeenCalledTimes(2));
        expect(
            await screen.findByText('No members in group.')
        ).toBeInTheDocument();
    });
});
