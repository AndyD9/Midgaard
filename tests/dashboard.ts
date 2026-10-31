/**
 * @file Suite d'interface du dashboard : `npm run test:ui` (environ 1 min).
 *
 * C'est le report qui durait depuis la Slice 1, et la dette n° 4 de la Slice 2.
 * Jusqu'ici le dashboard n'avait qu'un test de ses **fonctions pures**
 * (`tests/unit/dashboard-format.test.ts`) : aucun rendu, aucun chargement,
 * aucune régression visible. Or l'interface porte désormais des coûts, des
 * appels d'outils, des sources, et le seul bouton du harness qui **débloque**
 * une tâche.
 *
 * Ce qui est éprouvé ici ne l'est nulle part ailleurs, et chaque scénario vise
 * un invariant écrit, pas un pixel :
 *
 *  - D1 l'URL annoncée sert une **application qui démarre**, pas un fichier —
 *    c'est le défaut n° 1 de la Slice 0, poussé jusqu'au bout : S8 vérifie que
 *    l'URL répond, D1 vérifie qu'elle vit ;
 *  - D2 une tâche créée apparaît **sans rechargement** : la promesse du direct ;
 *  - D3 la progression avance seule, et sur le **vrai dénominateur** (défaut
 *    n° 3 de l'essai en vraie session) ;
 *  - D4 une approbation se donne **depuis le dashboard** et débloque la tâche —
 *    chemin que la Slice 2 reconnaissait n'avoir pas rejoué ;
 *  - D5 une tâche sans appel de modèle n'affiche **pas** « 0 $ » : zéro est un
 *    coût, pas une ignorance ;
 *  - D6 un lien profond rouvre la bonne tâche après rechargement ;
 *  - D7 la perte de la WebSocket **se voit** : un dashboard muet qui affiche
 *    des données d'apparence normale est pire qu'un dashboard en panne ;
 *  - D8 le diff d'une tâche Developer **se lit** : branche, fichiers, et le
 *    patch d'un fichier déplié — le livrable « diff consultable » de la
 *    Slice 3, avec un faux fournisseur qui joue les appels d'outils.
 *
 * Playwright est employé en **bibliothèque**, pas en lanceur : les suites de ce
 * dépôt ont leur forme (`scenario`, `summarize`, verdicts), et ajouter un second
 * lanceur avec sa configuration et son rapporteur coûterait plus qu'il ne rend.
 *
 * Prérequis, tous deux vérifiés avant le premier scénario et dits avec la
 * commande exacte : le dashboard compilé, et le navigateur de Playwright
 * téléchargé — `npm ci` ne le fait pas.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright'
import { daemonJson, pidAlive, readRuntime, type Approval, type RuntimeInfo, type TaskView } from '@midgaard/contracts'
import { StaticFiles, defaultDashboardDir } from '@midgaard/daemon'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFakeProvider } from './fake-provider.ts'
import { childEnv, nodeArgsFor, running, scenario, summarize, tempHome, type Outcome } from './helpers.ts'

/** Durée d'une tâche simulée : 5 étapes, donc 2 s par étape. Assez lent pour se voir. */
const TASK_S = 10
/** Plafond d'attente d'un élément à l'écran. Large : une CI lente ne doit pas rougir à tort. */
const UI_TIMEOUT = 20_000

const outcomes: Outcome[] = []
const { home, config, cleanup } = tempHome('ui')
let daemon: ChildProcess | undefined
let browser: Browser | undefined

/** Erreurs de la console du navigateur, collectées pour D1. */
const consoleErrors: string[] = []

// --- prérequis, dits avant de lancer quoi que ce soit ------------------------

const dashboard = new StaticFiles(defaultDashboardDir())
if (!dashboard.available) {
  console.error('Le dashboard n’est pas compilé : il n’y a rien à ouvrir.\n\n  npm run build\n')
  process.exit(1)
}

try {
  browser = await chromium.launch()
} catch (e) {
  console.error(
    `Le navigateur de Playwright est absent : ${(e as Error).message.split('\n')[0]}\n\n` +
      '  npx playwright install chromium\n\n' +
      '`npm ci` ne télécharge pas les navigateurs ; c’est une étape à part, et volontaire.\n',
  )
  process.exit(1)
}

// --- daemon réel, dossier jetable -------------------------------------------

/**
 * Démarre le daemon et attend qu'il réponde, comme le fait `tests/restart.ts`.
 *
 * @param port        port à imposer ; `0` laisse le système choisir. D7 relance
 *                    sur **le même port**, sans quoi la page ouverte viserait
 *                    une autre origine et ne pourrait pas se reconnecter.
 * @param previousPid pid du daemon précédent, pour ne pas confondre son fichier
 *                    de découverte encore présent avec celui du nouveau
 */
async function startDaemon(port = 0, previousPid?: number): Promise<RuntimeInfo> {
  daemon = spawn(process.execPath, nodeArgsFor('@midgaard/daemon/main'), {
    env: childEnv(home, { MIDGAARD_PORT: String(port) }),
    stdio: 'ignore',
  })
  for (let i = 0; i < 100; i++) {
    const info = readRuntime(config.runtimeFile)
    if (
      info &&
      info.pid !== previousPid &&
      (await daemonJson(info, '/api/health').then((r) => r.status === 200).catch(() => false))
    ) {
      return info
    }
    await sleep(100)
  }
  throw new Error('le daemon n’a pas répondu en 10 s')
}

const rt = await startDaemon()

/** Crée une tâche simulée par l'API du daemon, comme le ferait le serveur MCP. */
async function createTask(objective: string, needsApproval = false): Promise<TaskView> {
  const { body } = await daemonJson<TaskView>(rt, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ objective, duration_s: TASK_S, needs_approval: needsApproval }),
  })
  return body
}

/** État courant d'une tâche, lu côté daemon : la vérité, indépendante de l'écran. */
async function taskNow(id: string): Promise<TaskView['task']> {
  return (await daemonJson<TaskView>(rt, `/api/tasks/${id}`)).body.task
}

/** Attend qu'une condition soit vraie côté daemon, ou rend faux au bout du délai. */
async function until(predicate: () => Promise<boolean>, timeoutMs = UI_TIMEOUT): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(200)
  }
  return false
}

// --- navigateur --------------------------------------------------------------

const page: Page = await browser.newPage()
page.on('console', (m: ConsoleMessage) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e: Error) => consoleErrors.push(`exception : ${e.message}`))

/** Raccourci : attend qu'un texte soit visible, et dit vrai/faux plutôt que de lever. */
async function sees(text: string | RegExp, timeout = UI_TIMEOUT): Promise<boolean> {
  try {
    await page.getByText(text).first().waitFor({ state: 'visible', timeout })
    return true
  } catch {
    return false
  }
}

/**
 * Attend un état de connexion **dans le bandeau**, et nulle part ailleurs.
 *
 * `getByText('en direct')` ne suffit pas : l'écran vide contient « Elle
 * apparaîtra ici en direct. », et le premier jet de ce fichier a donc cru la
 * WebSocket ouverte alors qu'elle ne l'était pas — un faux positif dans un test
 * écrit précisément pour attraper les faux positifs de l'interface. Le bandeau
 * est un `<header>` ; on y restreint la recherche.
 *
 * @param label `en direct`, `déconnecté` ou `connexion…`
 */
async function connection(label: string, timeout = UI_TIMEOUT): Promise<boolean> {
  try {
    await page.locator('header').getByText(label).first().waitFor({ state: 'visible', timeout })
    return true
  } catch {
    return false
  }
}

// --- D1 ----------------------------------------------------------------------

await scenario(outcomes, 'D1 l’URL annoncée sert une application qui démarre', async () => {
  // `rt.dashboard_url` est l'URL que le daemon donne à Claude et à l'utilisateur.
  // On ouvre **celle-là**, pas une URL reconstruite : c'est elle qui est promise.
  await page.goto(rt.dashboard_url, { waitUntil: 'domcontentloaded' })

  // « en direct » n'apparaît que si trois choses ont marché d'affilée : les
  // fichiers servis, `/ui/bootstrap` qui rend le jeton, et la WebSocket ouverte
  // avec. Un seul texte, mais il couvre toute la chaîne de démarrage.
  const live = await connection('en direct')
  // Expression régulière plutôt que texte exact : l'apostrophe du JSX est
  // typographique ou droite selon l'humeur de l'éditeur, et ce test n'a pas à
  // en dépendre.
  const empty = await sees(/Rien à observer/)
  // Les exécutants sont montrés dès l'écran vide, avec leur motif de désactivation.
  const agents = await sees('simulated')

  if (!live) return { verdict: 'FAIL', detail: 'la WebSocket ne s’est jamais ouverte (badge « en direct » absent)' }
  if (!empty) return { verdict: 'FAIL', detail: 'l’écran vide n’explique pas quoi faire' }
  if (!agents) return { verdict: 'FAIL', detail: 'l’écran vide ne montre pas les exécutants' }
  if (consoleErrors.length) {
    return { verdict: 'FAIL', detail: `erreur(s) de console au démarrage : ${consoleErrors.join(' | ')}` }
  }
  return { verdict: 'PASS', detail: 'application montée, bootstrap obtenu, WebSocket ouverte, console muette' }
})

// --- D2 ----------------------------------------------------------------------

const vue = await (async () => {
  let created: TaskView | undefined
  await scenario(outcomes, 'D2 une tâche apparaît sans rechargement', async () => {
    const objective = 'Tâche observée en direct depuis le dashboard'
    // Aucune navigation après ce point : si le texte arrive, il est arrivé par
    // la WebSocket. C'est toute la promesse du direct.
    created = await createTask(objective)
    const appeared = await sees(objective)
    if (!appeared) return { verdict: 'FAIL', detail: 'la tâche n’est jamais apparue sans rechargement' }
    return { verdict: 'PASS', detail: `« ${created.task.id.slice(0, 8)}… » apparue par la WebSocket` }
  })
  return created
})()

// --- D3 ----------------------------------------------------------------------

await scenario(outcomes, 'D3 la progression avance seule, sur le vrai dénominateur', async () => {
  if (!vue) return { verdict: 'FAIL', detail: 'D2 n’a pas créé de tâche' }
  const attendu = vue.task.steps_total

  // Le dénominateur est l'invariant : le défaut n° 3 de l'essai en vraie session
  // affichait « 6/5 » parce que toutes les tâches héritaient de la constante du
  // simulé. Ici la tâche **est** simulée, donc 5 est juste — ce qu'on vérifie,
  // c'est que l'écran montre le `steps_total` de la tâche, et pas autre chose.
  const etape = page.getByText(/étape \d+\/\d+/).first()
  await etape.waitFor({ state: 'visible', timeout: UI_TIMEOUT })
  const premier = (await etape.textContent()) ?? ''
  const m = /étape (\d+)\/(\d+)/.exec(premier)
  if (!m) return { verdict: 'FAIL', detail: `progression illisible : ${JSON.stringify(premier)}` }
  if (Number(m[2]) !== attendu) {
    return { verdict: 'FAIL', detail: `dénominateur ${m[2]} affiché, ${attendu} attendu (steps_total de la tâche)` }
  }

  // Puis on regarde l'écran bouger, sans y toucher.
  const depart = Number(m[1])
  const bougé = await until(async () => {
    const t = (await etape.textContent()) ?? ''
    const n = /étape (\d+)\//.exec(t)
    return n ? Number(n[1]) > depart : false
  })
  if (!bougé) return { verdict: 'FAIL', detail: `la progression est restée à ${depart}/${attendu}` }
  return { verdict: 'PASS', detail: `étape ${depart}/${attendu} → avancée sans rechargement` }
})

// --- D5 (avant D4 : la tâche de D2 est encore sans appel de modèle) ----------

await scenario(outcomes, 'D5 une tâche sans appel de modèle n’affiche pas « 0 $ »', async () => {
  if (!vue) return { verdict: 'FAIL', detail: 'D2 n’a pas créé de tâche' }
  const t = await taskNow(vue.task.id)
  if (t.usage.model_calls !== 0) {
    return { verdict: 'FAIL', detail: `la tâche simulée a compté ${t.usage.model_calls} appel(s) : scénario invalide` }
  }
  // La ligne de la tâche dans la liste, et l'inspecteur : ni l'un ni l'autre ne
  // doit inventer un montant. Zéro est un coût ; ici il n'y a pas de mesure.
  const ligne = page.getByRole('button', { name: new RegExp(vue.task.objective.slice(0, 30)) }).first()
  await ligne.waitFor({ state: 'visible', timeout: UI_TIMEOUT })
  const texte = (await ligne.textContent()) ?? ''
  if (/\d\s*\$/.test(texte)) {
    return { verdict: 'FAIL', detail: `un montant est affiché sans appel de modèle : ${JSON.stringify(texte.trim())}` }
  }
  return { verdict: 'PASS', detail: 'aucun montant affiché, et aucun « 0 $ » inventé' }
})

// --- D4 ----------------------------------------------------------------------

await scenario(outcomes, 'D4 une approbation donnée dans le dashboard débloque la tâche', async () => {
  const objective = 'Tâche qui demande une décision humaine'
  const t = await createTask(objective, true)

  // On clique la tâche dans la liste avant d'attendre le panneau. Le dashboard
  // n'ouvre pas tout seul la nouvelle venue, et c'est **voulu** : `App.tsx`
  // explique que la tâche qu'on regarde s'échapperait au moment même où on
  // l'approuve, puisqu'elle cesserait alors d'être celle qui attend. Le
  // premier jet de ce scénario a pris ce comportement pour une panne.
  const ligne = page.getByRole('button', { name: new RegExp(objective) }).first()
  await ligne.waitFor({ state: 'visible', timeout: UI_TIMEOUT })
  await ligne.click()

  // Le panneau doit nommer **l'opération exacte** : une approbation vaut pour
  // elle et pour elle seule.
  const panneau = await sees('Décision humaine requise')
  if (!panneau) return { verdict: 'FAIL', detail: 'le panneau d’approbation ne s’est pas ouvert' }

  const attente = await until(async () => (await taskNow(t.task.id)).status === 'waiting_approval')
  if (!attente) return { verdict: 'FAIL', detail: 'la tâche n’est jamais passée en waiting_approval' }

  const { body } = await daemonJson<{ approvals: Approval[] }>(rt, '/api/approvals')
  const demande = body.approvals.find((a) => a.task_id === t.task.id)
  if (!demande) return { verdict: 'FAIL', detail: 'aucune demande d’approbation côté daemon' }
  if (!(await sees(demande.operation))) {
    return { verdict: 'FAIL', detail: `le panneau ne montre pas l’opération : ${JSON.stringify(demande.operation)}` }
  }

  // Le clic est l'acte humain. C'est le seul chemin d'approbation du dashboard,
  // et la Slice 2 ne l'avait pas rejoué faute d'outil qui en demande une.
  await page.getByRole('button', { name: 'Approuver' }).click()

  const reprise = await until(async () => (await taskNow(t.task.id)).status === 'completed', TASK_S * 1000 + UI_TIMEOUT)
  if (!reprise) {
    return { verdict: 'FAIL', detail: `la tâche est restée en ${(await taskNow(t.task.id)).status} après le clic` }
  }
  // Et l'écran doit le dire, sans rechargement.
  if (!(await sees('completed'))) return { verdict: 'FAIL', detail: 'la tâche est finie, l’écran l’ignore' }
  return { verdict: 'PASS', detail: `approuvée au clic, tâche reprise et terminée (${demande.id.slice(0, 8)}…)` }
})

// --- D6 ----------------------------------------------------------------------

await scenario(outcomes, 'D6 un lien profond rouvre la bonne tâche après rechargement', async () => {
  if (!vue) return { verdict: 'FAIL', detail: 'D2 n’a pas créé de tâche' }
  const id = vue.task.id
  // Le fragment est la source de vérité de la sélection : un lien d'approbation
  // transmis à quelqu'un doit ouvrir **sa** tâche, y compris après un F5.
  await page.goto(`${rt.dashboard_url}#/tasks/${id}`, { waitUntil: 'domcontentloaded' })
  if (!(await sees(id))) return { verdict: 'FAIL', detail: 'le lien profond n’a pas ouvert la tâche' }
  await page.reload({ waitUntil: 'domcontentloaded' })
  if (!(await sees(id))) return { verdict: 'FAIL', detail: 'le rechargement a perdu la sélection' }
  return { verdict: 'PASS', detail: `#/tasks/${id.slice(0, 8)}… ouvre et survit au rechargement` }
})

// --- D8 ----------------------------------------------------------------------

await scenario(outcomes, 'D8 le diff d’une tâche Developer se lit dans le dashboard', async () => {
  const provider = await startFakeProvider()
  const repos = realpathSync.native(mkdtempSync(join(tmpdir(), 'midgaard-ui-repo-')))
  try {
    await daemonJson(rt, '/api/providers', {
      method: 'POST',
      body: JSON.stringify({ id: 'faux', preset: 'custom', base_url: provider.url, default_model: 'faux-1', api_key: 'sk-faux-0000' }),
    })
    const repo = join(repos, 'projet')
    mkdirSync(join(repo, 'src'), { recursive: true })
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@example.org', '-c', 'commit.gpgsign=false', ...a], {
        cwd: repo,
        stdio: 'ignore',
      })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'src', 'app.ts'), 'export const routes = ["/"]\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'initial')

    provider.scripts.set('[D8]', [
      [{ tool: 'write_file', args: { path: 'src/health.ts', content: 'export const health = () => "ok"\n' } }],
      [{ tool: 'submit_result', args: { summary: 'route /health ajoutée', details: 'src/health.ts' } }],
    ])
    const { body: created } = await daemonJson<TaskView>(rt, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ objective: '[D8] ajouter /health', agent_id: 'developer', project_dir: repo }),
    })
    const id = created.task.id
    if (!(await until(async () => (await taskNow(id)).status === 'completed'))) {
      const t = await taskNow(id)
      return { verdict: 'FAIL', detail: `tâche non terminée : ${t.status} — ${t.error}` }
    }
    const branch = (await taskNow(id)).result?.workspace?.branch ?? '(absente)'

    await page.goto(`${rt.dashboard_url}#/tasks/${id}`, { waitUntil: 'domcontentloaded' })
    const card = page.getByTestId('workspace-card')
    try {
      await card.waitFor({ state: 'visible', timeout: UI_TIMEOUT })
    } catch {
      return { verdict: 'FAIL', detail: 'aucune carte « Fichiers et diff » pour une tâche Developer' }
    }
    if ((await card.getByTestId('workspace-branch').textContent()) !== branch) {
      return { verdict: 'FAIL', detail: `branche affichée différente de ${branch}` }
    }
    const file = card.getByTestId('workspace-files').getByText('src/health.ts')
    if (!(await file.isVisible())) return { verdict: 'FAIL', detail: 'le fichier créé n’est pas listé' }
    await file.click()
    // La ligne ajoutée, telle quelle, dans le patch déplié : rien n'en est interprété.
    if (!(await sees('+export const health = () => "ok"'))) {
      return { verdict: 'FAIL', detail: 'le patch du fichier ne s’affiche pas au clic' }
    }
    if (!(await sees(`git merge ${branch}`))) return { verdict: 'FAIL', detail: 'la commande de merge n’est pas montrée' }
    return { verdict: 'PASS', detail: `${branch} : fichier listé, patch déplié au clic, commande de merge montrée` }
  } finally {
    provider.server.close()
    rmSync(repos, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

// --- D7 (en dernier : il tue le daemon) --------------------------------------

await scenario(outcomes, 'D7 la perte de la WebSocket se voit, et le retour aussi', async () => {
  if (!daemon?.pid) return { verdict: 'FAIL', detail: 'pas de daemon à arrêter' }
  const mort = daemon.pid
  // Un dashboard temps réel qui a perdu sa connexion continue d'afficher des
  // données d'apparence normale. Sans témoin, on croit qu'il ne se passe rien.
  daemon.kill('SIGKILL')
  await until(async () => !pidAlive(mort), 5000)
  if (!(await connection('déconnecté'))) {
    return { verdict: 'FAIL', detail: 'le daemon est mort, le dashboard affiche toujours « en direct »' }
  }

  // Et le retour. C'est la seconde moitié qui compte : le jeton est régénéré à
  // chaque démarrage du daemon, et la page en garde un périmé. Tant qu'elle ne
  // l'oubliait pas, elle réessayait sans fin avec lui et ne revenait jamais —
  // sans rien dire d'autre que « déconnecté ».
  const neuf = await startDaemon(rt.port, mort)
  if (neuf.token === rt.token) {
    return { verdict: 'FAIL', detail: 'le daemon a rendu le même jeton : le scénario ne prouve rien' }
  }
  if (!(await connection('en direct', 30_000))) {
    return { verdict: 'FAIL', detail: 'daemon revenu, dashboard resté déconnecté (jeton périmé conservé ?)' }
  }
  return { verdict: 'PASS', detail: `déconnexion vue, puis reconnexion seule avec un jeton neuf (port ${neuf.port})` }
})

// --- nettoyage ---------------------------------------------------------------

await browser.close()
if (daemon && running(daemon)) daemon.kill('SIGKILL')
cleanup()
process.exit(summarize(outcomes, 'Interface du dashboard (Playwright)'))
