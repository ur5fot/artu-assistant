import { EventEmitter } from 'node:events';
import type { ServerPushEvent } from '@r2/shared';

export type ReminderPushEvent = ServerPushEvent;

export const reminderBus = new EventEmitter();
