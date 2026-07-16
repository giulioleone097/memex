import { type WikiLocation } from "./paths.js";
export declare const DOCTOR_CHECK_IDS: readonly ["node", "permissions", "git", "manifests", "config", "state", "locks", "retention", "secret-leakage", "vendor-assets", "legacy-storage"];
export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];
export type DoctorCheckStatus = "pass" | "warning" | "fail";
export interface DoctorCheck {
    id: DoctorCheckId;
    status: DoctorCheckStatus;
    message: string;
}
export interface RunDoctorOptions {
    location: WikiLocation;
    homeDir: string;
    pluginRoot?: string;
    vendorRoot?: string;
}
export interface DoctorResult {
    ok: boolean;
    checks: DoctorCheck[];
}
export declare function runDoctor(options: RunDoctorOptions): Promise<DoctorResult>;
