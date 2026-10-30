/**
 * @file Moteurs de tâches enfichables : ce qui fait réellement avancer une tâche.
 *
 * La Slice 1 avait conçu `TaskManager.tick()` pour être remplacé sans toucher au
 * reste. La Slice 2 encaisse ce pari en coupant la frontière au bon endroit :
 *
 *  - le **gérant** (`TaskManager`) garde tout ce qui ne dépend pas de l'exécutant :
 *    la machine à états, l'attente bloquante, les décisions humaines, les
 *    expirations, l'annulation ;
 *  - le **moteur** décide seulement de ce qui se passe entre le démarrage et la
 *    fin : des étapes minutées pour le simulé, une boucle modèle pour l'agent réel.
 *
 * Il y a donc deux moteurs, et le simulé **reste** : c'est le seul moyen
 * d'exercer la machine à états, les approbations et l'attente longue en
 * intégration continue sans appeler de modèle, donc sans dépenser un centime ni
 * dépendre d'un réseau. Les douze scénarios de bout en bout de la Slice 1
 * continuent de tourner tels quels.
 */
import type { Agent, AgentKind, Approval, HarnessConfig, Task } from '@midgaard/contracts'
import type { HarnessStore } from '@midgaard/persistence'
import type { EventBus } from '../bus.ts'

/**
 * Ce qu'un moteur emprunte au daemon.
 *
 * Il n'a **pas** accès au dépôt en écriture : toute écriture passe par le bus,
 * sinon un changement d'état échapperait aux long-polls et aux dashboards
 * connectés. C'est l'invariant central de la Slice 1, et un moteur n'y déroge pas.
 */
export interface EngineContext {
  config: HarnessConfig
  /** Lecture seule. Les écritures passent par {@link EngineContext.bus}. */
  store: HarnessStore
  bus: EventBus
  log: (...a: unknown[]) => void
  /**
   * Met la tâche en pause et crée la demande d'approbation correspondante.
   *
   * @param operation ce que l'humain autorise, en clair et sans abréviation
   * @param detail    la même opération, structurée : c'est d'elle que
   *                  l'empreinte est tirée, et elle est conservée avec la demande
   * @param payload   détail joint à l'événement `approval.requested`
   * @returns la demande créée, ou `null` si la tâche n'est plus en état de pauser
   */
  requestApproval(
    taskId: string,
    operation: string,
    detail: Record<string, unknown>,
    payload?: Record<string, unknown>,
  ): Approval | null
  /**
   * Conclut une annulation demandée, quand le moteur atteint un point de
   * contrôle en `cancel_requested`.
   *
   * C'est au moteur de décider **où** est ce point : lui seul sait ce qu'il a en
   * vol. C'est au gérant d'écrire la transition, pour que la machine à états
   * reste en un seul endroit.
   */
  concludeCancellation(taskId: string): void
}

/**
 * Un moteur d'exécution.
 *
 * Toutes les méthodes rendent la main **tout de suite** : un moteur qui bloque
 * bloquerait le daemon entier, long-polls compris. Le travail réel se fait sur
 * minuteur ou en tâche de fond.
 */
export interface TaskEngine {
  /** Profil d'agent que ce moteur sait exécuter. */
  readonly kind: AgentKind
  /** Démarre une tâche fraîchement créée. */
  start(task: Task, agent: Agent): void
  /**
   * Reprend après une approbation accordée.
   * La tâche est déjà repassée en `running` quand cette méthode est appelée.
   */
  resume(task: Task, agent: Agent): void
  /**
   * Signale une demande d'annulation.
   *
   * @returns `true` si le moteur s'est arrêté immédiatement et que le gérant peut
   *          conclure l'annulation ; `false` si l'arrêt sera **coopératif**, au
   *          prochain point de contrôle. Un appel de modèle en cours n'est pas
   *          interrompu : on l'a déjà payé, autant en récupérer le résultat et le
   *          compter.
   */
  cancel(task: Task): boolean
  /** Arrête tout, sans rien conclure : les tâches en vol seront `interrupted` au prochain démarrage. */
  stop(): void
}
