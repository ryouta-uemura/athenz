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
import styled from '@emotion/styled';
import Button from '../denali/Button';
import DateUtils from '../utils/DateUtils';
import { withRouter } from 'next/router';
import API from '../../api';

const StyleTable = styled.table`
    width: 100%;
    text-align: center;
    border-spacing: 0;
    display: table;
    border-collapse: separate;
    border-color: black;
    box-sizing: border-box;
    margin-top: 5px;
    box-shadow: 0 1px 4px #d9d9d9;
    border: 5px solid #fff;
    -webkit-border-image: none;
    border-image: none;
    -webkit-border-image: initial;
    border-image: initial;
    max-height: 600px;
`;

const StyledDiv = styled.div`
    display: inline-block;
    overflow-y: scroll;
    max-height: 600px;
`;

const StyledTr = styled.tr`
    &:nth-child(even) {
        background-color: #3570f40d;
    }
`;

const StyledTh = styled.th`
    padding: 6px;
    border: 1px solid #dddddd;
`;

const StyledTd = styled.td`
    border: 1px solid #dddddd;
    padding: 5px;
`;

class GroupMemberList extends React.Component {
    constructor(props) {
        super(props);
        this.viewGroup = this.viewGroup.bind(this);
        this.loadMembers = this.loadMembers.bind(this);
        this.localDate = new DateUtils();
        this.state = { loading: true, members: null, error: false };
    }

    componentDidMount() {
        this.mounted = true;
        this.loadMembers();
    }

    componentWillUnmount() {
        this.mounted = false;
    }

    async loadMembers() {
        const [domainName, groupName] = this.props.groupName.split(':group.');
        this.setState({ loading: true, members: null, error: false });
        try {
            const group = await API().getGroup(
                domainName,
                groupName,
                false,
                false
            );
            if (this.mounted) {
                this.setState({
                    loading: false,
                    members: Array.isArray(group)
                        ? null
                        : group.groupMembers || [],
                    error: false,
                });
            }
        } catch (error) {
            if (this.mounted) {
                this.setState({ loading: false, members: null, error: true });
            }
        }
    }

    viewGroup(e) {
        e.stopPropagation();
        let dom = this.props.groupName.split(':group.')[0];
        let grp = this.props.groupName.split(':group.')[1];
        this.props.router.push(
            `/domain/${dom}/group/${grp}/members`,
            `/domain/${dom}/group/${grp}/members`
        );
    }

    render() {
        const { loading, members, error } = this.state;
        let rows;
        if (loading || error || members === null || members.length === 0) {
            rows = (
                <StyledTr>
                    <StyledTd colSpan={2}>
                        {loading
                            ? 'Loading group members...'
                            : error
                            ? 'Unable to load group members.'
                            : members === null
                            ? 'Group not found.'
                            : 'No members in group.'}
                        {error && (
                            <Button secondary onClick={this.loadMembers}>
                                Retry
                            </Button>
                        )}
                    </StyledTd>
                </StyledTr>
            );
        } else {
            rows = members.map((item) => {
                return (
                    <StyledTr key={item.memberName}>
                        <StyledTd>{item.memberName}</StyledTd>
                        <StyledTd>
                            {item.expiration
                                ? this.localDate.getLocalDate(
                                      item.expiration,
                                      this.props.timeZone,
                                      this.props.timeZone
                                  )
                                : 'N/A'}
                        </StyledTd>
                    </StyledTr>
                );
            });
        }

        return (
            <StyledDiv>
                <StyleTable>
                    {members && members.length > 0 ? (
                        <StyledTr>
                            <StyledTh> Member </StyledTh>
                            <StyledTh> Expiry </StyledTh>
                        </StyledTr>
                    ) : (
                        ''
                    )}

                    {rows}
                    <tfoot colspan={'0'}>
                        <tr>
                            <StyledTd colSpan={2}>
                                <Button secondary onClick={this.viewGroup}>
                                    View Members
                                </Button>
                            </StyledTd>
                        </tr>
                    </tfoot>
                </StyleTable>
            </StyledDiv>
        );
    }
}
export default withRouter(GroupMemberList);
