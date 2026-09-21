import type { ManifestPayload, LoopDeps } from './orchestrator.js';
import type { SessionLauncher } from './launcher.js';
export interface BridgeConfig {
    python?: string;
    module?: string;
}
export declare class ForwardBridge {
    private readonly cfg;
    constructor(cfg?: BridgeConfig);
    fetchManifest(rid: string, elapsedMin: number): Promise<ManifestPayload | null>;
    appendEvent(rid: string, payload: Record<string, unknown>): Promise<void>;
    writeCheckpoint(rid: string, stage: string, iter: string, state: Record<string, unknown>): Promise<void>;
    readLatestCheckpoint(rid: string): Promise<Record<string, unknown> | null>;
    /** 组装 LoopDeps（bin 入口用） */
    deps(launcher: SessionLauncher): LoopDeps;
}
//# sourceMappingURL=python-bridge.d.ts.map