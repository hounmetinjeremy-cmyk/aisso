import { useStore } from '@nanostores/react';
import { ClientOnly } from 'remix-utils/client-only';
import { chatStore } from '~/lib/stores/chat';
import { sidebarOpen } from '~/lib/stores/sidebar';
import { classNames } from '~/utils/classNames';
import { HeaderActionButtons } from './HeaderActionButtons.client';
import { ChatDescription } from '~/lib/persistence/ChatDescription.client';

export function Header() {
  const chat = useStore(chatStore);

  return (
    <header
      className={classNames('flex items-center px-4 border-b h-[var(--header-height)]', {
        'border-transparent': !chat.started,
        'border-bolt-elements-borderColor': chat.started,
      })}
    >
      <div className="flex items-center gap-2 z-logo text-bolt-elements-textPrimary cursor-pointer">
        <button
          type="button"
          onClick={() => sidebarOpen.set(!sidebarOpen.get())}
          aria-label="Ouvrir le menu (compte, historique des conversations)"
          className="flex items-center justify-center bg-transparent border-0 p-1 -ml-1 cursor-pointer"
        >
          <span className="i-ph:list-bold text-2xl text-bolt-elements-textPrimary" />
        </button>
        <a href="/" className="text-xl font-semibold flex items-center gap-2">
          <img src="/logo.svg" alt="" className="w-7 h-7 inline-block" />
          <span className="text-bolt-elements-textPrimary">Aïsso</span>
        </a>
      </div>
      {chat.started && ( // Display ChatDescription and HeaderActionButtons only when the chat has started.
        <>
          <span className="flex-1 pl-4 pr-2 truncate text-left text-bolt-elements-textPrimary">
            <ClientOnly>{() => <ChatDescription />}</ClientOnly>
          </span>
          <ClientOnly>
            {() => (
              <div className="">
                <HeaderActionButtons chatStarted={chat.started} />
              </div>
            )}
          </ClientOnly>
        </>
      )}
    </header>
  );
}
