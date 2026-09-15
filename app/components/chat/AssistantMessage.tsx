import { memo } from 'react';
import { Markdown } from './Markdown';
import WithTooltip from '~/components/ui/Tooltip';
import type { ProviderInfo } from '~/types/model';
import type { DynamicToolUIPart, UIMessage } from 'ai';
import { ToolInvocations } from './ToolInvocations';
import type { ToolCallAnnotation } from '~/types/context';
import type { AppendMessage } from './appendMessage';

interface AssistantMessageProps {
  content: string;
  messageId?: string;
  onRewind?: (messageId: string) => void;
  onFork?: (messageId: string) => void;
  append?: (message: AppendMessage) => void;
  chatMode?: 'discuss' | 'build';
  setChatMode?: (mode: 'discuss' | 'build') => void;
  model?: string;
  provider?: ProviderInfo;
  parts: UIMessage['parts'] | undefined;
}

export const AssistantMessage = memo(
  ({
    content,
    messageId,
    onRewind,
    onFork,
    append,
    chatMode,
    setChatMode,
    model,
    provider,
    parts,
  }: AssistantMessageProps) => {
    const toolInvocations = parts?.filter((part): part is DynamicToolUIPart => part.type === 'dynamic-tool');
    const toolCallAnnotations = (parts?.filter((part) => part.type === 'data-toolCall') ?? []).map(
      (part: any) => part.data as ToolCallAnnotation,
    );

    return (
      <div className="overflow-hidden w-full">
        <>
          <div className=" flex gap-2 items-center text-sm text-bolt-elements-textSecondary mb-2">
            <div className="flex w-full items-center justify-between">
              {(onRewind || onFork) && messageId && (
                <div className="flex gap-2 flex-col lg:flex-row ml-auto">
                  {onRewind && (
                    <WithTooltip tooltip="Revert to this message">
                      <button
                        onClick={() => onRewind(messageId)}
                        key="i-ph:arrow-u-up-left"
                        className="i-ph:arrow-u-up-left text-xl text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary transition-colors"
                      />
                    </WithTooltip>
                  )}
                  {onFork && (
                    <WithTooltip tooltip="Fork chat from this message">
                      <button
                        onClick={() => onFork(messageId)}
                        key="i-ph:git-fork"
                        className="i-ph:git-fork text-xl text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary transition-colors"
                      />
                    </WithTooltip>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
        <Markdown append={append} chatMode={chatMode} setChatMode={setChatMode} model={model} provider={provider} html>
          {content}
        </Markdown>
        {toolInvocations && toolInvocations.length > 0 && (
          <ToolInvocations toolInvocations={toolInvocations} toolCallAnnotations={toolCallAnnotations} />
        )}
      </div>
    );
  },
);
