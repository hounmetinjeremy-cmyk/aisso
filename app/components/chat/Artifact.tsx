import { useStore } from '@nanostores/react';
import { AnimatePresence, motion } from 'framer-motion';
import { computed } from 'nanostores';
import { memo, useEffect, useRef, useState } from 'react';
import type { ActionState } from '~/lib/runtime/action-runner';
import { workbenchStore } from '~/lib/stores/workbench';
import { classNames } from '~/utils/classNames';
import { cubicEasingFn } from '~/utils/easings';
import { WORK_DIR } from '~/utils/constants';

interface ArtifactProps {
  messageId: string;
  artifactId: string;
}

export const Artifact = memo(({ artifactId }: ArtifactProps) => {
  const userToggledActions = useRef(false);
  const [showActions, setShowActions] = useState(false);
  const [allActionFinished, setAllActionFinished] = useState(false);

  const artifacts = useStore(workbenchStore.artifacts);
  const artifact = artifacts[artifactId];

  /*
   * Mode MCP / sans WebContainer : on n'affiche plus la carte
   * « Creating Project… / Creating initial files / Click to open Workbench ».
   * Les artefacts « bundled » servent uniquement au bootstrap WebContainer.
   */
  if (!artifact || artifact.type === 'bundled') {
    return null;
  }

  const actions = useStore(
    computed(artifact.runner.actions, (actions) => {
      // Filter out Supabase actions except for migrations
      return Object.values(actions).filter((action) => action.type !== 'supabase');
    }),
  );

  const toggleActions = () => {
    userToggledActions.current = true;
    setShowActions(!showActions);
  };

  useEffect(() => {
    if (actions.length && !showActions && !userToggledActions.current) {
      setShowActions(true);
    }

    if (actions.length !== 0 && artifact.type === 'bundled') {
      const finished = !actions.find((action) => action.status !== 'complete');

      if (allActionFinished !== finished) {
        setAllActionFinished(finished);
      }
    }
  }, [actions, artifact.type, allActionFinished]);

  // Determine the dynamic title based on state for bundled artifacts
  const dynamicTitle =
    artifact?.type === 'bundled'
      ? allActionFinished
        ? artifact.id === 'restored-project-setup'
          ? 'Project Restored'
          : 'Project Created'
        : artifact.id === 'restored-project-setup'
          ? 'Restoring Project...'
          : 'Creating Project...'
      : artifact?.title;

  return (
    <>
      <div className="artifact border border-bolt-elements-borderColor flex flex-col overflow-hidden rounded-lg w-full transition-border duration-150">
        <div className="flex">
          <button
            className="flex items-stretch bg-bolt-elements-artifacts-background hover:bg-bolt-elements-artifacts-backgroundHover w-full overflow-hidden"
            onClick={() => {
              const showWorkbench = workbenchStore.showWorkbench.get();
              workbenchStore.showWorkbench.set(!showWorkbench);
            }}
          >
            <div className="px-5 p-3.5 w-full text-left">
              <div className="w-full text-bolt-elements-textPrimary font-medium leading-5 text-sm">{dynamicTitle}</div>
              <div className="w-full w-full text-bolt-elements-textSecondary text-xs mt-0.5">
                Click to open Workbench
              </div>
            </div>
          </button>
          <div className="bg-bolt-elements-artifacts-borderColor w-[1px]" />
          <button
            className="bg-bolt-elements-artifacts-background hover:bg-bolt-elements-artifacts-backgroundHover"
            onClick={toggleActions}
          >
            <div className="p-4">
              {showActions ? <div className="i-ph:caret-up-bold"></div> : <div className="i-ph:caret-down-bold"></div>}
            </div>
          </button>
        </div>
        {artifact.type === 'bundled' && (
          <div className="flex items-center gap-1.5 p-5 bg-bolt-elements-actions-background">
            <div className={classNames('text-lg', getIconColor(allActionFinished ? 'complete' : 'running'))}>
              {allActionFinished ? (
                <div className="i-ph:check"></div>
              ) : (
                <div className="i-svg-spinners:90-ring-with-bg"></div>
              )}
            </div>
            <div className="text-bolt-elements-textPrimary font-medium leading-5 text-sm">
              {allActionFinished
                ? artifact.id === 'restored-project-setup'
                  ? 'Restore files from snapshot'
                  : 'Initial files created'
                : 'Creating initial files'}
            </div>
          </div>
        )}
        <AnimatePresence>
          {artifact.type !== 'bundled' && showActions && actions.length > 0 && (
            <motion.div
              className="actions"
              initial={{ height: 0 }}
              animate={{ height: 'auto' }}
              exit={{ height: '0px' }}
              transition={{ duration: 0.15 }}
            >
              <div className="bg-bolt-elements-artifacts-borderColor h-[1px]" />

              <div className="p-5 text-left bg-bolt-elements-actions-background">
                <ActionList actions={actions} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
});

interface ActionListProps {
  actions: ActionState[];
}

const actionVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

export function openArtifactInWorkbench(filePath: any) {
  if (workbenchStore.currentView.get() !== 'code') {
    workbenchStore.currentView.set('code');
  }

  workbenchStore.setSelectedFile(`${WORK_DIR}/${filePath}`);
}

const ActionList = memo(({ actions }: ActionListProps) => {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
      <ul className="list-none space-y-2.5">
        {actions.map((action, index) => {
          const { status, type, content, filePath } = action as any;

          return (
            <motion.li
              key={index}
              variants={actionVariants}
              initial="hidden"
              animate="visible"
              transition={{
                duration: 0.2,
                ease: cubicEasingFn,
              }}
            >
              <div className="flex items-center gap-1.5 text-sm">
                <div className={classNames('text-lg', getIconColor(status))}>
                  {status === 'running' ? (
                    <div className="i-svg-spinners:90-ring-with-bg"></div>
                  ) : status === 'pending' ? (
                    <div className="i-ph:circle-dashed"></div>
                  ) : status === 'complete' ? (
                    <div className="i-ph:check"></div>
                  ) : status === 'failed' || status === 'aborted' ? (
                    <div className="i-ph:x"></div>
                  ) : null}
                </div>
                <div className="text-bolt-elements-textPrimary">
                  {type === 'file' ? (
                    <span>
                      Create{' '}
                      <code
                        className="bg-bolt-elements-artifacts-inlineCode-background text-bolt-elements-artifacts-inlineCode-text px-1.5 py-0.5 rounded-md"
                        onClick={() => openArtifactInWorkbench(filePath)}
                      >
                        {filePath}
                      </code>
                    </span>
                  ) : type === 'shell' ? (
                    <div className="flex items-center w-full min-h-[28px]">
                      <span className="flex-1">Run command</span>
                    </div>
                  ) : type === 'start' ? (
                    <div className="flex items-center w-full min-h-[28px]">
                      <span className="flex-1">Start application</span>
                    </div>
                  ) : null}
                </div>
              </div>
              {type === 'shell' && content && (
                <div className="ml-6 mt-1 text-xs text-bolt-elements-textSecondary font-mono">{content}</div>
              )}
            </motion.li>
          );
        })}
      </ul>
    </motion.div>
  );
});

function getIconColor(status: ActionState['status'] | 'complete' | 'running') {
  switch (status) {
    case 'pending': {
      return 'text-bolt-elements-textTertiary';
    }
    case 'running': {
      return 'text-bolt-elements-loader-progress';
    }
    case 'complete': {
      return 'text-bolt-elements-icon-success';
    }
    case 'aborted': {
      return 'text-bolt-elements-textSecondary';
    }
    case 'failed': {
      return 'text-bolt-elements-icon-error';
    }
    default: {
      return 'text-bolt-elements-textTertiary';
    }
  }
}
