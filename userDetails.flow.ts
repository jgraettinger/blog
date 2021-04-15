import { anchors, collections, interfaces, registers } from 'flow/modules';
import * as _ from 'lodash';

// Implementation for derivation userDetails.flow.yaml#/collections/userDetails/derivation.
export class UserDetails implements interfaces.UserDetails {
    // Add or update this {message: timestamp} in the room-state register.
    fromMessagesUpdate(source: collections.Messages): registers.UserDetails[] {
        return [
            {
                messages: { [source.id]: source.delete ? -1 : source.timestamp },
                subscribers: [],
            },
        ];
    }
    // Add or update the user's room subscription in the room-state register.
    fromRoomUsersUpdate(source: collections.RoomUsers): registers.UserDetails[] {
        if (source.delete) {
            return [
                {
                    messages: {},
                    subscribers: [
                        {
                            userId: source.userId,
                            seenTimestamp: Number.MAX_SAFE_INTEGER,
                            delete: true,
                        },
                    ],
                },
            ];
        } else {
            return [
                {
                    messages: {},
                    subscribers: [
                        {
                            userId: source.userId,
                            seenTimestamp: source.seenTimestamp,
                        },
                    ],
                },
            ];
        }
    }

    fromMessagesPublish(
        _source: collections.Messages,
        register: registers.UserDetails,
        previous: registers.UserDetails,
    ): collections.UserDetails[] {
        return toggleUnread(previous, register);
    }
    fromRoomUsersPublish(
        _source: collections.RoomUsers,
        register: registers.UserDetails,
        previous: registers.UserDetails,
    ): collections.UserDetails[] {
        return toggleUnread(previous, register);
    }
}

function toggleUnread(previous: registers.UserDetails, next: registers.UserDetails): collections.UserDetails[] {
    // Find previous and next max message timestamps.
    const prevTime = _.max(Object.values(previous.messages)) ?? 0;
    const nextTime = _.max(Object.values(next.messages)) ?? 0;

    // Do a sorted full outer join of previous and next subscribers
    // on their already-ordered userID. Collect updates for each user
    // whose room-is-unread status changes between |previous| and |next|.

    const merge = (l: anchors.RoomSubscriber | undefined, r: anchors.RoomSubscriber | undefined) => {
        // If the left or right subscription doesn't exist, then the room is implicitly "seen".
        const wasSeen = !l || l.seenTimestamp >= prevTime,
            isSeen = !r || r.seenTimestamp >= nextTime,
            id = l?.userId ?? r?.userId ?? '';

        if (wasSeen && !isSeen) {
            out.push({ id: id, numUnreadRooms: 1 });
        } else if (!wasSeen && isSeen) {
            out.push({ id: id, numUnreadRooms: -1 });
        } else if (!l) {
            out.push({ id: id, numUnreadRooms: 0 });
        }
    };

    const out: collections.UserDetails[] = [],
        l = previous.subscribers,
        r = next.subscribers;

    // TODO(johnny): There's probably a nice library for this ?
    while (l.length && r.length) {
        if (l[0].userId < r[0].userId) {
            merge(l.shift(), undefined);
        } else if (l[0].userId > r[0].userId) {
            merge(undefined, r.shift());
        } else {
            merge(l.shift(), r.shift());
        }
    }
    while (l.length) {
        merge(l.shift(), undefined);
    }
    while (r.length) {
        merge(undefined, r.shift());
    }

    return out;
}
