// Analysis-model shell state: the registry snapshot, active-id sync
// with the shell, and the select/cycle entry points. Decision paths
// stay pure in analysismodel.ts; this hook owns the wiring and state
// so App only consumes { model, models, switching, select, cycle }.

import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { nextModelId, performModelSelect } from "./analysismodel";
import { startAnalysisSweep } from "./analysissweep";
import {
  downloadAnalysisModel,
  listAnalysisModels,
  setAnalysisModel,
  switchAnalysisModel,
  type AnalysisModelInfo,
} from "./ipc";
import type { AnalysisModel } from "./prefs";

export interface AnalysisModelShell {
  /** Active Beat This! model (small default; switchable to standard). */
  model: AnalysisModel;
  /** Registry snapshot: which models exist and which have weights. */
  models: AnalysisModelInfo[];
  /** True while a switch (or its prerequisite download) is in flight. */
  switching: boolean;
  /** Switch to a registered model, downloading weights on demand. */
  select(id: string): void;
  /** Cycle to the next registered model — the status-bar shortcut. */
  cycle(): void;
}

export function useAnalysisModelShell(
  initialModel: AnalysisModel,
  onError: (message: string) => void,
  toast: (text: string) => void,
): AnalysisModelShell {
  // Kept in sync with the shell so the sweep runs the chosen engine.
  const [model, setModel] = useState<AnalysisModel>(initialModel);
  const [models, setModels] = useState<AnalysisModelInfo[]>([]);
  // Disables the cycle button so a second click can't race the reopen.
  const [switching, setSwitching] = useState(false);

  // Sync the persisted model id into the shell's active-model state at
  // startup. The sweep reads the active id when it loads the engine, so
  // a restart resumes under the user's chosen model. No reopen here —
  // the index already stamps each verdict, and a model switch (via
  // performModelSelect) reopens only foreign-model rows.
  useEffect(() => {
    void setAnalysisModel(model).catch((e) => onError(String(e)));
  }, [model, onError]);

  // Pull the registry + availability so the cycle button can offer a
  // download-and-switch for the unbundled standard model. Re-fetch on
  // analysis-model-downloaded so a completed download flips `available`
  // live.
  const refresh = useCallback(() => {
    void listAnalysisModels()
      .then((r) => {
        setModels(r.models);
        // The shell is the authority for the active id; if the pref and
        // the shell ever disagree (e.g. a future model removed from the
        // registry), trust the shell.
        if (r.activeId !== model) setModel(r.activeId as AnalysisModel);
      })
      .catch(() => {});
  }, [model]);
  useEffect(() => {
    refresh();
    const unlisten = listen("analysis-model-downloaded", () => refresh());
    return () => {
      unlisten.then((off) => off());
    };
  }, [refresh]);

  /** Shared by the status-bar cycle button and the Settings overlay's
      explicit picker; the decision paths live in analysismodel.ts
      (pure, tested). */
  const select = useCallback(
    (id: string) => {
      setSwitching(true);
      void performModelSelect(
        {
          switchModel: switchAnalysisModel,
          downloadModel: downloadAnalysisModel,
          onSwitched: (switched) => {
            setModel(switched as AnalysisModel);
            startAnalysisSweep();
          },
          onError,
          toast,
        },
        id,
        models,
        model,
        switching,
      ).finally(() => setSwitching(false));
    },
    [switching, models, model, onError, toast],
  );

  const cycle = useCallback(() => {
    const id = nextModelId(models, model);
    if (id != null) select(id);
  }, [models, model, select]);

  return { model, models, switching, select, cycle };
}
