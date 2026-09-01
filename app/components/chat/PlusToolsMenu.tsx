import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { classNames } from '~/utils/classNames';
import { IconButton } from '~/components/ui/IconButton';
import { ColorSchemeDialog } from '~/components/ui/ColorSchemeDialog';
import { McpTools } from './MCPTools';
import { WebSearch } from './WebSearch.client';
import { SupabaseConnection } from './SupabaseConnection';
import type { DesignScheme } from '~/types/design-scheme';

interface PlusToolsMenuProps {
  onUploadFile: () => void;
  designScheme?: DesignScheme;
  setDesignScheme?: (scheme: DesignScheme) => void;
  onWebSearchResult: (result: string) => void;
  webSearchDisabled?: boolean;
  canEnhance: boolean;
  enhancingPrompt?: boolean;
  onEnhancePrompt: () => void;
  chatStarted: boolean;
  chatMode?: 'discuss' | 'build';
  setChatMode?: (mode: 'discuss' | 'build') => void;
}

/*
 * Regroupe tous les outils secondaires (pièce jointe, palette, MCP, recherche web,
 * amélioration de prompt, mode discussion, Supabase) derrière un seul bouton "+",
 * comme le fait l'app Claude ("Ajouter au chat") — au lieu de les étaler en rangée
 * à côté du champ de saisie.
 */
export function PlusToolsMenu(props: PlusToolsMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleOutsideClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);

    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div className="relative shrink-0" ref={menuRef}>
      <IconButton title="Ajouter au chat" className="rounded-full !p-2 shrink-0" onClick={() => setOpen(!open)}>
        <div className={classNames('text-lg', open ? 'i-ph:x-bold' : 'i-ph:plus-bold')} />
      </IconButton>

      {open && (
        <div className="absolute bottom-full left-0 mb-2 min-w-[220px] py-1.5 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 shadow-lg z-50 flex flex-col gap-0.5">
          <button
            type="button"
            className="flex items-center gap-2.5 px-3 py-2 text-sm text-bolt-elements-textPrimary hover:bg-bolt-elements-item-backgroundActive rounded-md mx-1"
            onClick={() => {
              props.onUploadFile();
              close();
            }}
          >
            <div className="i-ph:paperclip text-lg" />
            <span>Importer un fichier</span>
          </button>

          <button
            type="button"
            disabled={!props.canEnhance}
            className="flex items-center gap-2.5 px-3 py-2 text-sm text-bolt-elements-textPrimary hover:bg-bolt-elements-item-backgroundActive rounded-md mx-1 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => {
              props.onEnhancePrompt();
              toast.success('Prompt enhanced!');
              close();
            }}
          >
            {props.enhancingPrompt ? (
              <div className="i-svg-spinners:90-ring-with-bg text-lg animate-spin" />
            ) : (
              <div className="i-bolt:stars text-lg" />
            )}
            <span>Améliorer le prompt</span>
          </button>

          {props.chatStarted && (
            <button
              type="button"
              className={classNames(
                'flex items-center gap-2.5 px-3 py-2 text-sm rounded-md mx-1 hover:bg-bolt-elements-item-backgroundActive',
                props.chatMode === 'discuss'
                  ? 'text-bolt-elements-item-contentAccent'
                  : 'text-bolt-elements-textPrimary',
              )}
              onClick={() => {
                props.setChatMode?.(props.chatMode === 'discuss' ? 'build' : 'discuss');
                close();
              }}
            >
              <div className="i-ph:chats text-lg" />
              <span>Mode discussion</span>
              {props.chatMode === 'discuss' && <div className="i-ph:check-bold text-sm ml-auto" />}
            </button>
          )}

          <div className="h-px bg-bolt-elements-borderColor my-1 mx-2" />

          <div className="flex items-center gap-2.5 px-3 py-1.5 mx-1 text-sm text-bolt-elements-textPrimary">
            <div className="i-ph:palette text-lg" />
            <span>Palette de couleurs</span>
            <div className="ml-auto">
              <ColorSchemeDialog designScheme={props.designScheme} setDesignScheme={props.setDesignScheme} />
            </div>
          </div>

          <div className="flex items-center gap-2.5 px-3 py-1.5 mx-1 text-sm text-bolt-elements-textPrimary">
            <div className="i-ph:plugs-connected text-lg" />
            <span>Outils MCP</span>
            <div className="ml-auto">
              <McpTools />
            </div>
          </div>

          <div className="flex items-center gap-2.5 px-3 py-1.5 mx-1 text-sm text-bolt-elements-textPrimary">
            <div className="i-ph:globe text-lg" />
            <span>Recherche Web</span>
            <div className="ml-auto">
              <WebSearch onSearchResult={props.onWebSearchResult} disabled={props.webSearchDisabled} />
            </div>
          </div>

          <div className="flex items-center gap-2.5 px-3 py-1.5 mx-1 text-sm text-bolt-elements-textPrimary">
            <div className="i-ph:database text-lg" />
            <span>Supabase</span>
            <div className="ml-auto">
              <SupabaseConnection />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
