import { AnimatePresence, motion } from 'framer-motion';
import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ProgressAnnotation } from '~/types/context';
import { classNames } from '~/utils/classNames';
import { cubicEasingFn } from '~/utils/easings';
import { workbenchStore } from '~/lib/stores/workbench';

/*
 * Mots affichés pendant qu'une étape générique ("réflexion", "poursuite du
 * traitement") est en cours — remplace le message brut par une rotation
 * façon Claude Code, purement cosmétique : ça ne prétend décrire aucune
 * donnée réelle, contrairement aux métriques du pied de liste (voir plus
 * bas) qui elles restent 100% dérivées de l'état réel du tour en cours.
 */
const THINKING_WORDS = [
  'Réflexion',
  'Pondering',
  'Ça travaille',
  'Brewing',
  'Ça mijote',
  'Working',
  'Ça calcule',
  'Thinking',
];

function useThinkingWord(active: boolean): string {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!active) {
      return undefined;
    }

    const interval = setInterval(() => setIndex((i) => (i + 1) % THINKING_WORDS.length), 1800);

    return () => clearInterval(interval);
  }, [active]);

  return THINKING_WORDS[index];
}

/** Une étape encore en cours côté serveur ("Étape N sur M : réflexion..."/"Étape N sur M en cours…") — on y superpose le mot animé plutôt que d'afficher le texte brut. */
function isGenericStepMessage(message: string): boolean {
  return /étape \d+ sur \d+.*en cours/i.test(message);
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Compte réel des fichiers touchés par le workbench pour ce tour — jamais de chiffre inventé. */
function useLiveFileStats(tick: number) {
  return useMemo(() => {
    const artifacts = Object.values(workbenchStore.artifacts.get());
    let total = 0;
    let complete = 0;

    for (const artifact of artifacts) {
      const actions = Object.values(artifact.runner.actions.get());

      for (const action of actions) {
        if ((action as any).type === 'file') {
          total++;

          if (action.status === 'complete') {
            complete++;
          }
        }
      }
    }

    return { total, complete };

    // `tick` force un recalcul périodique sur une lecture .get() non réactive (pas d'abonnement direct au store).
  }, [tick]);
}

export default function ProgressCompilation({ data }: { data?: ProgressAnnotation[] }) {
  const [progressList, setProgressList] = React.useState<ProgressAnnotation[]>([]);
  const [expanded, setExpanded] = useState(false);
  const firstSeenAt = useRef<Map<string, number>>(new Map());
  const settledAt = useRef<Map<string, number>>(new Map());
  const [tick, forceTick] = useReducer((c) => c + 1, 0);

  React.useEffect(() => {
    if (!data || data.length == 0) {
      setProgressList([]);
      return;
    }

    const progressMap = new Map<string, ProgressAnnotation>();
    data.forEach((x) => {
      const existingProgress = progressMap.get(x.label);

      if (existingProgress && existingProgress.status === 'complete') {
        return;
      }

      progressMap.set(x.label, x);
    });

    const newData = Array.from(progressMap.values());
    newData.sort((a, b) => a.order - b.order);
    setProgressList(newData);
  }, [data]);

  const hasActiveStep = progressList.some((p) => p.status === 'in-progress');

  // Horodatages : première apparition de chaque étape, et instant où elle a cessé d'être "in-progress".
  useEffect(() => {
    const now = Date.now();

    for (const item of progressList) {
      if (!firstSeenAt.current.has(item.label)) {
        firstSeenAt.current.set(item.label, now);
      }

      if (item.status !== 'in-progress' && !settledAt.current.has(item.label)) {
        settledAt.current.set(item.label, now);
      }
    }
  }, [progressList]);

  // Tick régulier pendant qu'une étape tourne : fait vivre les timers ET le compte de fichiers en temps réel.
  useEffect(() => {
    if (!hasActiveStep) {
      return undefined;
    }

    const interval = setInterval(forceTick, 1000);

    return () => clearInterval(interval);
  }, [hasActiveStep]);

  const fileStats = useLiveFileStats(tick);
  const stepEntries = progressList.filter((p) => p.label.startsWith('step-'));
  const stepsDone = stepEntries.filter((p) => p.status === 'complete').length;

  const elapsedFor = (item: ProgressAnnotation): number => {
    const start = firstSeenAt.current.get(item.label) ?? Date.now();
    const end = item.status === 'in-progress' ? Date.now() : (settledAt.current.get(item.label) ?? Date.now());

    return end - start;
  };

  if (progressList.length === 0) {
    return <></>;
  }

  return (
    <AnimatePresence>
      <div
        className={classNames(
          'bg-bolt-elements-background-depth-2',
          'border border-bolt-elements-borderColor',
          'shadow-lg rounded-lg  relative w-full max-w-chat mx-auto z-prompt',
          'p-1',
        )}
      >
        <div
          className={classNames(
            'bg-bolt-elements-item-backgroundAccent',
            'p-1 rounded-lg text-bolt-elements-item-contentAccent',
            'flex ',
          )}
        >
          <div className="flex-1">
            <AnimatePresence>
              {expanded ? (
                <motion.div
                  className="actions"
                  initial={{ height: 0 }}
                  animate={{ height: 'auto' }}
                  exit={{ height: '0px' }}
                  transition={{ duration: 0.15 }}
                >
                  {progressList.map((x, i) => {
                    return <ProgressItem key={i} progress={x} elapsedMs={elapsedFor(x)} />;
                  })}
                  {(fileStats.total > 0 || stepEntries.length > 0) && (
                    <StatsFooter stepsDone={stepsDone} stepsTotal={stepEntries.length} fileStats={fileStats} />
                  )}
                </motion.div>
              ) : (
                <ProgressItem progress={progressList.slice(-1)[0]} elapsedMs={elapsedFor(progressList.slice(-1)[0])} />
              )}
            </AnimatePresence>
          </div>
          <motion.button
            initial={{ width: 0 }}
            animate={{ width: 'auto' }}
            exit={{ width: 0 }}
            transition={{ duration: 0.15, ease: cubicEasingFn }}
            className=" p-1 rounded-lg bg-bolt-elements-item-backgroundAccent hover:bg-bolt-elements-artifacts-backgroundHover"
            onClick={() => setExpanded((v) => !v)}
          >
            <div className={expanded ? 'i-ph:caret-up-bold' : 'i-ph:caret-down-bold'}></div>
          </motion.button>
        </div>
      </div>
    </AnimatePresence>
  );
}

const ProgressItem = ({ progress, elapsedMs }: { progress: ProgressAnnotation; elapsedMs: number }) => {
  const isActive = progress.status === 'in-progress';
  const isGeneric = isGenericStepMessage(progress.message);
  const thinkingWord = useThinkingWord(isActive && isGeneric);
  const stepPrefix = progress.message.match(/^Étape \d+ sur \d+/i)?.[0];
  const label = isActive && isGeneric && stepPrefix ? `${stepPrefix} · ${thinkingWord}…` : progress.message;

  return (
    <motion.div
      className={classNames('flex text-sm gap-3 items-center justify-between')}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <div>
          {progress.status === 'in-progress' ? (
            <div className="i-svg-spinners:90-ring-with-bg"></div>
          ) : progress.status === 'complete' ? (
            <div className="i-ph:check"></div>
          ) : progress.status === 'error' ? (
            <div className="i-ph:x text-bolt-elements-icon-error"></div>
          ) : null}
        </div>
        <span className={classNames('truncate', progress.status === 'error' ? 'text-bolt-elements-icon-error' : '')}>
          {label}
        </span>
      </div>
      <span className="text-xs opacity-70 tabular-nums shrink-0">{formatElapsed(elapsedMs)}</span>
    </motion.div>
  );
};

const StatsFooter = ({
  stepsDone,
  stepsTotal,
  fileStats,
}: {
  stepsDone: number;
  stepsTotal: number;
  fileStats: { total: number; complete: number };
}) => {
  return (
    <motion.div
      className="flex items-center gap-3 text-xs opacity-80 pt-1.5 mt-1.5 border-t border-bolt-elements-item-contentAccent/20"
      initial={{ opacity: 0 }}
      animate={{ opacity: 0.8 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      {stepsTotal > 0 && (
        <span className="flex items-center gap-1">
          <div className="i-ph:list-checks" />
          {stepsDone}/{stepsTotal} étapes
        </span>
      )}
      {fileStats.total > 0 && (
        <span className="flex items-center gap-1">
          <div className="i-ph:file-text" />
          {fileStats.complete}/{fileStats.total} fichiers
        </span>
      )}
    </motion.div>
  );
};
