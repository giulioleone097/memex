import type { WikiLocation } from "./paths.js";
export declare const SCHEDULE_COMMANDS: readonly ["update", "ingest"];
export type ScheduleCommand = (typeof SCHEDULE_COMMANDS)[number];
export interface ScheduleIntentV1 {
    schemaVersion: 1;
    id: string;
    command: ScheduleCommand;
    cron: string;
    timezone?: string;
    enabled: boolean;
    sourceId?: string;
}
export interface SetScheduleOptions {
    location: WikiLocation;
    schedule: unknown;
}
export interface SetScheduleResult {
    changed: boolean;
    schedule: ScheduleIntentV1;
}
export interface RemoveScheduleOptions {
    location: WikiLocation;
    id: string;
}
export interface RemoveScheduleResult {
    id: string;
    removed: boolean;
}
export declare function setSchedule(options: SetScheduleOptions): Promise<SetScheduleResult>;
export declare function listSchedules(location: WikiLocation): Promise<ScheduleIntentV1[]>;
export declare function removeSchedule(options: RemoveScheduleOptions): Promise<RemoveScheduleResult>;
