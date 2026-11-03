/**
 * @file L'éditeur du dashboard, **en lecture seule** (Slice 6) : CodeMirror 6
 * pour un fichier, ou deux côte à côte pour son diff contre le commit de départ.
 *
 * Lecture seule à deux niveaux : l'état refuse toute modification
 * (`EditorState.readOnly`) et la vue n'accepte pas le focus d'édition
 * (`EditorView.editable`). L'agent reste le seul à écrire (décision de
 * l'auteur) ; le daemon, de toute façon, n'a aucune route d'écriture.
 *
 * Le contenu vient de fichiers écrits par un agent : CodeMirror l'affiche comme
 * du texte, sans rien en interpréter. Les couleurs sont celles du thème du
 * dashboard (variables CSS) : l'éditeur suit le thème clair ou sombre du
 * système, comme le reste de la page.
 */
import { useEffect, useRef } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { MergeView } from '@codemirror/merge'
import { tags } from '@lezer/highlight'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { python } from '@codemirror/lang-python'
import type { Language } from '@/lib/files'

/** Coloration syntaxique tirée des rôles du thème. */
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.modifier], color: 'var(--color-accent)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--color-done)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--color-waiting)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--color-muted)', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.className], color: 'var(--color-running)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--color-running)' },
  { tag: tags.heading, fontWeight: '600', color: 'var(--color-accent)' },
  { tag: tags.invalid, color: 'var(--color-danger)' },
])

/** Habillage de l'éditeur : les couleurs et la police de la page. */
const look = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'var(--color-surface)', color: 'var(--color-ink)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-gutters': { backgroundColor: 'var(--color-canvas)', color: 'var(--color-muted)', borderRight: '1px solid var(--color-border)' },
  '.cm-content': { caretColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
})

/** Extension du langage d'un fichier ; rien pour du texte brut. */
function languageExtension(language: Language | null): Extension[] {
  switch (language) {
    case 'typescript':
      return [javascript({ typescript: true, jsx: true })]
    case 'javascript':
      return [javascript({ jsx: true })]
    case 'json':
      return [json()]
    case 'markdown':
      return [markdown()]
    case 'css':
      return [css()]
    case 'html':
      return [html()]
    case 'python':
      return [python()]
    default:
      return []
  }
}

/** Ce que partagent l'éditeur simple et les deux côtés du diff. */
function extensions(language: Language | null): Extension[] {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    lineNumbers(),
    syntaxHighlighting(highlight),
    look,
    ...languageExtension(language),
  ]
}

/**
 * Un fichier, ou son diff.
 *
 * @param text  le fichier sur le disque ; `''` pour un fichier supprimé
 * @param base  le fichier au commit de départ, pour le diff ; `''` s'il a été créé
 * @param mode  `file` (un éditeur) ou `diff` (départ à gauche, travail à droite)
 */
export function CodeView({
  text,
  base,
  mode,
  language,
}: {
  text: string
  base: string
  mode: 'file' | 'diff'
  language: Language | null
}) {
  const host = useRef<HTMLDivElement>(null)
  const single = useRef<EditorView | null>(null)
  const merge = useRef<MergeView | null>(null)

  // L'éditeur se recrée quand le mode ou le langage change : ce sont des choix
  // de structure, rares. Le contenu, lui, se met à jour sur place (plus bas).
  useEffect(() => {
    const parent = host.current
    if (!parent) return
    if (mode === 'file') {
      single.current = new EditorView({ parent, state: EditorState.create({ doc: text, extensions: extensions(language) }) })
    } else {
      merge.current = new MergeView({
        parent,
        a: { doc: base, extensions: extensions(language) },
        b: { doc: text, extensions: extensions(language) },
        gutter: true,
        highlightChanges: true,
        collapseUnchanged: { margin: 3, minSize: 6 },
      })
    }
    return () => {
      single.current?.destroy()
      merge.current?.destroy()
      single.current = null
      merge.current = null
    }
    // Le contenu initial est lu à la création ; ses changements passent par
    // l'effet suivant, d'où son absence des dépendances.
  }, [mode, language])

  // Le fichier change pendant que l'agent écrit : le document est remplacé sans
  // recréer l'éditeur, ce qui garde la position de défilement de l'utilisateur.
  useEffect(() => {
    const replace = (view: EditorView | undefined | null, doc: string) => {
      if (!view || view.state.doc.toString() === doc) return
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } })
    }
    if (single.current) replace(single.current, text)
    if (merge.current) {
      // Le diff se recalcule sur les deux documents : on le reconstruit plutôt
      // que de remplacer un côté, que MergeView ne réaligne pas de lui-même.
      if (merge.current.a.state.doc.toString() !== base || merge.current.b.state.doc.toString() !== text) {
        const parent = host.current!
        merge.current.destroy()
        merge.current = new MergeView({
          parent,
          a: { doc: base, extensions: extensions(language) },
          b: { doc: text, extensions: extensions(language) },
          gutter: true,
          highlightChanges: true,
          collapseUnchanged: { margin: 3, minSize: 6 },
        })
      }
    }
  }, [text, base, language])

  return <div ref={host} className="h-full min-h-0 overflow-auto" data-testid={mode === 'diff' ? 'code-diff' : 'code-file'} />
}
