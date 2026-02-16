/**
 * Server-side bot AI for the claw-shooter.
 *
 * Ported from the reference PlayroomKit BotController.jsx, adapted for
 * server-authoritative execution. Each AI bot gets a BotBrain that runs
 * a decision tree every engine tick and queues actions through the same
 * pipeline as external API agents (engine.queueAction).
 *
 * Key behaviours:
 *  - Personality-driven combat (5 types with distinct modifiers)
 *  - Target selection with priority scoring
 *  - Line-of-sight raycasting and obstacle avoidance
 *  - Stuck detection & multi-stage recovery
 *  - Stalemate handling with target exclusion
 *  - Weapon-seeking when unarmed, ammo awareness
 *  - Strafe + wander patterns for natural movement
 */

import type { ShooterEngine } from './engine.js';
import type { ShooterPlayer, WeaponPickup, ShooterMatch } from '../../shared/shooter-types.js';
import {
  WEAPON_TYPES,
  WEAPON_STATS,
  WEAPON_TIER,
  PERSONALITY_MODS,
  type PersonalityType,
  type WeaponType,
  PLAYER_MOVE_SPEED,
  PICKUP_RADIUS,

  // Bot AI tuning constants
  BOT_MELEE_RANGE,
  BOT_KNIFE_RUSH_RADIUS,
  BOT_KITE_DIST,
  BOT_OBSTACLE_LOOKAHEAD,
  BOT_STUCK_CHECK_INTERVAL_MS,
  BOT_STUCK_DISTANCE_THRESHOLD,
  BOT_STUCK_TIME_THRESHOLD_MS,
  BOT_STUCK_RECOVERY_DURATIONS,
  BOT_STALEMATE_CHECK_INTERVAL_MS,
  BOT_STALEMATE_DIST_DELTA,
  BOT_STALEMATE_TIME_THRESHOLD_MS,
  BOT_NO_LOS_STANDOFF_MS,
  BOT_NO_LOS_STANDOFF_BREAK_DURATION_MS,
  BOT_NO_LOS_EXCLUDE_DURATION_MS,
  BOT_NO_LOS_PATH_PERSIST_MS,
  BOT_STRAFE_CHANGE_INTERVAL_MS,
  BOT_WANDER_CHANGE_MIN_MS,
  BOT_WANDER_CHANGE_MAX_MS,
  BOT_LOW_AMMO_THRESHOLD,
  BOT_TARGET_LOCK_MIN_MS,
  BOT_STUCK_WANDER_MS,
  BOT_TARGET_NO_LIMIT,
} from '../../shared/shooter-constants.js';

// ── Helper types ──────────────────────────────────────────────────

interface EnemyInfo {
  id: string;
  x: number;
  z: number;
  distance: number;
  angleDeg: number;       // angle from bot to enemy in degrees
  health: number;
  lives: number;
  weapon: WeaponType;
  alive: boolean;
}

interface PickupInfo {
  id: string;
  type: WeaponType;
  x: number;
  z: number;
  distance: number;
  angleDeg: number;
}

// ── BotBrain: per-bot state & decision making ─────────────────────

export class BotBrain {
  readonly playerId: string;
  readonly personality: PersonalityType;

  // Wander state
  private wanderAngleDeg = Math.random() * 360;
  private wanderChangeTime = 0;

  // Strafe state
  private strafeDir: 1 | -1 = Math.random() > 0.5 ? 1 : -1;
  private strafeChangeTime = 0;

  // Stuck detection & recovery
  private lastStuckCheckTime = 0;
  private lastStuckPos: { x: number; z: number } | null = null;
  private stuckAccumMs = 0;
  private stuckConsecutiveCount = 0;
  private recovery: { active: boolean; angleDeg: number; until: number } = {
    active: false, angleDeg: 0, until: 0,
  };
  private lastMoveAngleDeg = 0;
  private recoveryQuadrant = 0;

  // Stalemate / engagement tracking
  private engagement = {
    targetId: null as string | null,
    startTime: 0,
    lastDist: Infinity,
    lastCheckTime: 0,
    noLOSExcludeUntil: {} as Record<string, number>,
  };

  // No-LOS path persistence (avoid left-right oscillation)
  private noLOSPath = { angleDeg: 0, until: 0 };

  // No-LOS standoff: when we've had no LOS to target for a while (e.g. wall between us), break the chase
  private noLOSSince = 0;
  private forceStandoffUntil = 0;
  private forceStandoffAngleDeg = 0;

  // Obstacle avoidance direction persistence (prevents oscillation)
  private cachedAvoidDir: { angleDeg: number; until: number } = { angleDeg: 0, until: 0 };

  // Goal commitment (prevents flip-flopping between gun and enemy)
  private goalCommitment: { type: 'gun' | 'rush' | 'hunt' | null; until: number; targetId: string | null } = {
    type: null, until: 0, targetId: null,
  };

  // Position record for "stuck with no one nearby" -> wander
  private lastPosition: { x: number; z: number } | null = null;
  private lastPositionTime = 0;
  private forceWanderUntil = 0;

  // Oscillation: detect back-and-forth in same area and force a turn to escape
  private moveAngleSamples: { angle: number; time: number }[] = [];
  private static readonly OSCILLATION_SAMPLE_INTERVAL_MS = 400;
  private static readonly OSCILLATION_TURN_DURATION_MS = 1800;
  private forceTurnUntil = 0;
  private forceTurnAngleDeg = 0;

  constructor(playerId: string, personality: PersonalityType) {
    this.playerId = playerId;
    this.personality = personality;
  }

  /**
   * Run one tick of bot AI. Returns the action(s) to queue, or null if no action needed.
   */
  tick(
    match: ShooterMatch,
    engine: ShooterEngine,
  ): void {
    const player = match.players.get(this.playerId);
    if (!player || !player.alive || player.eliminated) return;

    const now = Date.now();
    const mods = PERSONALITY_MODS[this.personality];

    // Gather world state
    const allEnemies = this.getAllEnemies(match, player);
    const allPickups = this.getAllPickups(match, player);
    const nearestPickup = allPickups.length > 0 ? allPickups[0] : null;

    const hasGun = player.weapon !== WEAPON_TYPES.KNIFE;
    const weaponStats = WEAPON_STATS[player.weapon];

    // ── Target selection: stick to current target unless dead or in knife range (stops forward/back flip-flop) ──
    let target: EnemyInfo | null = null;
    const currentTarget = this.engagement.targetId ? allEnemies.find((e) => e.id === this.engagement.targetId) : null;

    if (currentTarget && currentTarget.alive && currentTarget.distance > BOT_MELEE_RANGE) {
      target = currentTarget;
    } else {
      target = this.selectTarget(allEnemies, now, null, BOT_TARGET_NO_LIMIT);
      if (target && target.id !== this.engagement.targetId) {
        this.engagement = {
          ...this.engagement,
          targetId: target.id,
          startTime: now,
          lastDist: target.distance,
          lastCheckTime: now,
        };
        this.noLOSPath = { angleDeg: 0, until: 0 };
      }
    }

    const hasLOS = target
      ? engine.hasLineOfSight(player.x, player.z, target.x, target.z, this.playerId)
      : false;

    // Update engagement tracking (don't switch target here; we only switch when target is dead or in melee range)
    if (target) {
      if (this.engagement.targetId === target.id) {
        if (now - this.engagement.lastCheckTime > BOT_STALEMATE_CHECK_INTERVAL_MS) {
          this.engagement.lastCheckTime = now;
          this.engagement.lastDist = target.distance;
        }
      }
    } else {
      this.engagement.targetId = null;
    }

    const hasLOSToTarget = target
      ? engine.hasLineOfSight(player.x, player.z, target.x, target.z, this.playerId)
      : false;

    // ── No-LOS standoff: if we've had no LOS for a while (e.g. wall between us), break the left-right chase ──
    if (target && this.engagement.targetId === target.id) {
      if (hasLOSToTarget) {
        this.noLOSSince = 0;
        this.forceStandoffUntil = 0;
      } else {
        if (this.noLOSSince === 0) this.noLOSSince = now;
        if (now - this.noLOSSince >= BOT_NO_LOS_STANDOFF_MS && now > this.forceStandoffUntil) {
          this.forceStandoffUntil = now + BOT_NO_LOS_STANDOFF_BREAK_DURATION_MS;
          const side = Math.random() > 0.5 ? 1 : -1;
          this.forceStandoffAngleDeg = target.angleDeg + side * (90 + (Math.random() - 0.5) * 60);
          while (this.forceStandoffAngleDeg < 0) this.forceStandoffAngleDeg += 360;
          while (this.forceStandoffAngleDeg >= 360) this.forceStandoffAngleDeg -= 360;
          this.noLOSPath = { angleDeg: 0, until: 0 };
          this.noLOSSince = 0;
        }
      }
    } else {
      this.noLOSSince = 0;
      this.forceStandoffUntil = 0;
    }
    if (now > this.forceStandoffUntil) this.forceStandoffUntil = 0;

    // ── Stuck detection & recovery ──
    this.updateStuckDetection(player, target, allEnemies, engine, now);

    // ── Wander angle ──
    if (now - this.wanderChangeTime > BOT_WANDER_CHANGE_MIN_MS + Math.random() * (BOT_WANDER_CHANGE_MAX_MS - BOT_WANDER_CHANGE_MIN_MS)) {
      this.wanderAngleDeg = Math.random() * 360;
      this.wanderChangeTime = now;
    }

    // ── Position record: if same position 3s and no enemies nearby, force wander to find new target ──
    const enemyNearby = allEnemies.length > 0;
    const distFromLast = this.lastPosition
      ? Math.sqrt((player.x - this.lastPosition.x) ** 2 + (player.z - this.lastPosition.z) ** 2)
      : Infinity;
    if (distFromLast > BOT_STUCK_DISTANCE_THRESHOLD || this.lastPosition === null) {
      this.lastPosition = { x: player.x, z: player.z };
      this.lastPositionTime = now;
    }
    if (!enemyNearby && this.lastPosition && distFromLast < BOT_STUCK_DISTANCE_THRESHOLD && now - this.lastPositionTime >= BOT_STUCK_WANDER_MS) {
      this.forceWanderUntil = now + 2000;
      this.wanderAngleDeg = Math.random() * 360;
      this.wanderChangeTime = now;
      this.goalCommitment = { type: null, until: 0, targetId: null };
      this.lastPosition = null;
    }
    if (now > this.forceWanderUntil) this.forceWanderUntil = 0;

    // ── Strafe direction toggle ──
    if (now - this.strafeChangeTime > BOT_STRAFE_CHANGE_INTERVAL_MS) {
      this.strafeDir = Math.random() > 0.5 ? 1 : -1;
      this.strafeChangeTime = now;
    }

    // ── Goal commitment check ──
    // If we have an active commitment, check if it should be broken
    if (this.goalCommitment.type && now < this.goalCommitment.until) {
      const gc = this.goalCommitment;
      if (gc.type === 'gun') {
        // Break gun commitment only if enemy enters melee range
        if (target && target.distance <= BOT_MELEE_RANGE) {
          this.goalCommitment = { type: null, until: 0, targetId: null };
        }
        // Break if we got a gun
        if (hasGun) {
          this.goalCommitment = { type: null, until: 0, targetId: null };
        }
      } else if (gc.type === 'rush') {
        // Break rush commitment if target dies, disappears, or gets very far
        const rushTarget = gc.targetId ? allEnemies.find(e => e.id === gc.targetId) : null;
        if (!rushTarget || !rushTarget.alive) {
          this.goalCommitment = { type: null, until: 0, targetId: null };
        }
        // Break if a weapon is very close (opportunistic grab)
        if (nearestPickup && nearestPickup.distance < 3) {
          this.goalCommitment = { type: null, until: 0, targetId: null };
        }
      } else if (gc.type === 'hunt') {
        // Break hunt commitment if target dies
        const huntTarget = gc.targetId ? allEnemies.find(e => e.id === gc.targetId) : null;
        if (!huntTarget || !huntTarget.alive) {
          this.goalCommitment = { type: null, until: 0, targetId: null };
        }
      }
    } else {
      this.goalCommitment = { type: null, until: 0, targetId: null };
    }

    // ── Decision tree ──
    let moveAngleDeg: number | null = null;
    let shouldShoot = false;
    let aimAngleDeg = player.angle;
    let shouldMelee = false;
    let shouldPickup = false;

    // No distance limit: if it's on the map, we target it
    const enemyDetected = !!target;
    const pickupAvailable = !!nearestPickup;
    const activeGoal = this.goalCommitment.type;

    // Danger-close: if we have a gun, any enemy within kite range (e.g. knife behind us) gets shot at first
    const dangerCloseEnemy = hasGun && allEnemies.length > 0
      ? allEnemies.filter((e) => e.distance < BOT_KITE_DIST).sort((a, b) => a.distance - b.distance)[0] ?? null
      : null;
    const hasLOSToDanger = dangerCloseEnemy
      ? engine.hasLineOfSight(player.x, player.z, dangerCloseEnemy.x, dangerCloseEnemy.z, this.playerId)
      : false;

    // Shoot as soon as target is in weapon range (don't wait to get closer)
    const gunRange = weaponStats && !weaponStats.isMelee ? weaponStats.range : 0;
    const targetInGunRange = target && gunRange > 0 && target.distance <= gunRange && hasLOSToTarget && (player.ammo ?? 0) > 0;

    // Priority 0: Follow existing goal commitment
    if (activeGoal === 'gun' && nearestPickup) {
      moveAngleDeg = nearestPickup.angleDeg;
      if (nearestPickup.distance < PICKUP_RADIUS + 0.5) shouldPickup = true;
      // Still melee if enemy is right on top of us
      if (target && target.distance <= BOT_MELEE_RANGE) {
        aimAngleDeg = target.angleDeg;
        shouldMelee = true;
      }

    } else if (activeGoal === 'rush' && target) {
      if (target.distance <= BOT_MELEE_RANGE) {
        aimAngleDeg = target.angleDeg;
        shouldMelee = true;
      } else {
        moveAngleDeg = target.angleDeg;
      }

    } else if (activeGoal === 'hunt' && target) {
      moveAngleDeg = target.angleDeg;

    // Priority 1: No gun, pickup closer than enemy or enemy far -> get armed
    } else {
      // No distance limit: if a weapon is on the map and we're unarmed, go for it (unless in knife rush range of enemy)
      const goForWeapon = !hasGun && nearestPickup && (!target || target.distance > BOT_KNIFE_RUSH_RADIUS);

      if (goForWeapon) {
        moveAngleDeg = nearestPickup!.angleDeg;
        if (nearestPickup!.distance < PICKUP_RADIUS + 0.5) {
          shouldPickup = true;
        }
        this.goalCommitment = { type: 'gun', until: now + 1500, targetId: nearestPickup!.id };

      // Priority 2: Has gun, enemy detected — shoot as soon as in range; react to danger-close (e.g. knife behind)
      } else if (hasGun && (enemyDetected || targetInGunRange) && target) {
        if (dangerCloseEnemy && hasLOSToDanger && (player.ammo ?? 0) > 0) {
          aimAngleDeg = dangerCloseEnemy.angleDeg;
          shouldShoot = true;
        } else if (targetInGunRange) {
          shouldShoot = true;
          const spread = (weaponStats?.spread ?? 0.02) * (2 - mods.accuracy);
          const noiseDeg = ((Math.random() - 0.5) * spread * 2 * 180) / Math.PI;
          aimAngleDeg = target.angleDeg + noiseDeg;
        } else {
          aimAngleDeg = target.angleDeg;
        }

        if (allEnemies.length === 1) {
          moveAngleDeg = target.angleDeg;
        } else if (target.distance < BOT_KITE_DIST) {
          moveAngleDeg = target.angleDeg + 180;
        } else if (target.distance > mods.preferredDist * 0.9) {
          moveAngleDeg = target.angleDeg;
        } else {
          moveAngleDeg = target.angleDeg + 72 * this.strafeDir;
        }

      // Priority 3: Knife, enemy within rush radius -> pursue and melee
      } else if (!hasGun && target && target.distance < BOT_KNIFE_RUSH_RADIUS) {
        if (target.distance <= BOT_MELEE_RANGE) {
          aimAngleDeg = target.angleDeg;
          shouldMelee = true;
        } else {
          moveAngleDeg = target.angleDeg;
        }
        // Commit to rushing this enemy
        this.goalCommitment = { type: 'rush', until: now + 2000, targetId: target.id };

      // Priority 4: Knife, enemy detected but far -> close in or grab very close pickup
      } else if (!hasGun && enemyDetected && target) {
        if (target.distance <= BOT_MELEE_RANGE) {
          aimAngleDeg = target.angleDeg;
          shouldMelee = true;
        } else if (nearestPickup && nearestPickup.distance < 3 && target.distance > BOT_KNIFE_RUSH_RADIUS) {
          moveAngleDeg = nearestPickup.angleDeg;
          if (nearestPickup.distance < PICKUP_RADIUS + 0.5) shouldPickup = true;
        } else {
          moveAngleDeg = target.angleDeg;
          // Commit to hunting this enemy
          this.goalCommitment = { type: 'hunt', until: now + 2000, targetId: target.id };
        }

      // Priority 5: No enemy nearby, no gun -> sprint to nearest weapon
      } else if (pickupAvailable && !hasGun) {
        moveAngleDeg = nearestPickup!.angleDeg;
        if (nearestPickup!.distance < PICKUP_RADIUS + 0.5) shouldPickup = true;
        this.goalCommitment = { type: 'gun', until: now + 1500, targetId: nearestPickup!.id };

      // Priority 6: Low ammo, pickup available -> grab another weapon
      } else if (hasGun && (player.ammo ?? 0) <= BOT_LOW_AMMO_THRESHOLD && pickupAvailable) {
        moveAngleDeg = nearestPickup!.angleDeg;
        if (nearestPickup!.distance < PICKUP_RADIUS + 0.5) shouldPickup = true;

      // Priority 7: Enemy exists (any range) -> move toward them; still shoot if in gun range
      } else if (target) {
        moveAngleDeg = target.angleDeg;
        this.goalCommitment = { type: 'hunt', until: now + 3000, targetId: target.id };
        if (hasGun && (player.ammo ?? 0) > 0 && targetInGunRange) {
          shouldShoot = true;
          const spread = (weaponStats?.spread ?? 0.02) * (2 - mods.accuracy);
          aimAngleDeg = target.angleDeg + ((Math.random() - 0.5) * spread * 2 * 180) / Math.PI;
        }

      // Priority 8: Nobody found -> patrol toward map center, then wander
      } else {
        const toCenterAngle = (Math.atan2(-player.z, -player.x) * 180) / Math.PI;
        const distToCenter = Math.sqrt(player.x * player.x + player.z * player.z);
        moveAngleDeg = distToCenter > 15 ? toCenterAngle : this.wanderAngleDeg;
      }
    }

    if (this.forceStandoffUntil > now && moveAngleDeg !== null) {
      moveAngleDeg = this.forceStandoffAngleDeg;
    }

    if (this.forceTurnUntil > now && moveAngleDeg !== null) {
      moveAngleDeg = this.forceTurnAngleDeg;
    }

    if (this.forceWanderUntil > now && moveAngleDeg !== null) {
      moveAngleDeg = this.wanderAngleDeg;
    }

    // ── Recovery overrides movement ──
    if (this.recovery.active && now < this.recovery.until) {
      moveAngleDeg = this.recovery.angleDeg;
    } else if (this.recovery.active) {
      this.recovery.active = false;
    }

    // ── No LOS to target: path around obstacles (skip when only one enemy so we close in directly)
    if (
      moveAngleDeg !== null &&
      target &&
      !hasLOSToTarget &&
      !this.recovery.active &&
      allEnemies.length > 1
    ) {
      let towardTarget = moveAngleDeg - target.angleDeg;
      while (towardTarget > 180) towardTarget -= 360;
      while (towardTarget < -180) towardTarget += 360;

      if (Math.abs(towardTarget) < 60) {
        if (now < this.noLOSPath.until) {
          moveAngleDeg = this.noLOSPath.angleDeg;
        } else {
          moveAngleDeg = engine.findLongestClearDirection(
            player.x, player.z, target.angleDeg,
            BOT_OBSTACLE_LOOKAHEAD * 4, this.playerId,
          );
          this.noLOSPath = { angleDeg: moveAngleDeg, until: now + BOT_NO_LOS_PATH_PERSIST_MS };
        }
      }
    }

    if (moveAngleDeg !== null) {
      this.lastMoveAngleDeg = moveAngleDeg;
    }

    // ── Oscillation: detect back-and-forth in same area, force a turn to escape loop ──
    if (moveAngleDeg !== null && now > this.forceTurnUntil) {
      const lastSample = this.moveAngleSamples[this.moveAngleSamples.length - 1];
      if (!lastSample || now - lastSample.time >= BotBrain.OSCILLATION_SAMPLE_INTERVAL_MS) {
        this.moveAngleSamples.push({ angle: moveAngleDeg, time: now });
      }
      const cutoff = now - 2500;
      this.moveAngleSamples = this.moveAngleSamples.filter((s) => s.time >= cutoff);
      if (this.moveAngleSamples.length >= 3) {
        for (const s of this.moveAngleSamples.slice(-4)) {
          let diff = Math.abs(moveAngleDeg - (s.angle + 180));
          while (diff > 180) diff = Math.abs(diff - 360);
          if (diff < 55) {
            this.forceTurnUntil = now + BotBrain.OSCILLATION_TURN_DURATION_MS;
            this.forceTurnAngleDeg = this.lastMoveAngleDeg + 90 + (Math.random() - 0.5) * 60;
            while (this.forceTurnAngleDeg < 0) this.forceTurnAngleDeg += 360;
            while (this.forceTurnAngleDeg >= 360) this.forceTurnAngleDeg -= 360;
            this.moveAngleSamples = [];
            break;
          }
        }
      }
    }
    if (now > this.forceTurnUntil) this.forceTurnUntil = 0;

    // ── Obstacle-aware movement: steer around walls ──
    if (moveAngleDeg !== null) {
      // If we have a cached avoidance direction that's still valid, use it
      if (now < this.cachedAvoidDir.until) {
        // But only if the cached direction is still clear
        const cachedClear = engine.castRayInDirection(
          player.x, player.z, this.cachedAvoidDir.angleDeg,
          BOT_OBSTACLE_LOOKAHEAD, this.playerId,
        );
        if (cachedClear > BOT_OBSTACLE_LOOKAHEAD * 0.5) {
          moveAngleDeg = this.cachedAvoidDir.angleDeg;
        } else {
          // Cached direction is now blocked, re-evaluate
          this.cachedAvoidDir.until = 0;
        }
      }

      if (now >= this.cachedAvoidDir.until) {
        const steered = engine.findClearDirection(
          player.x, player.z, moveAngleDeg, BOT_OBSTACLE_LOOKAHEAD, this.playerId,
        );

        // Check if the steered direction is sufficiently clear
        const clearDist = engine.castRayInDirection(
          player.x, player.z, steered, BOT_OBSTACLE_LOOKAHEAD, this.playerId,
        );

        if (clearDist < 1.5) {
          // Wall is very close -- escalate to full 8-direction search
          moveAngleDeg = engine.findLongestClearDirection(
            player.x, player.z, moveAngleDeg,
            BOT_OBSTACLE_LOOKAHEAD * 3, this.playerId,
          );
        } else {
          moveAngleDeg = steered;
        }

        // Cache this direction for 400ms to prevent oscillation
        this.cachedAvoidDir = { angleDeg: moveAngleDeg, until: now + 400 };
      }
    }

    // ── Queue actions ──
    if (shouldPickup) {
      engine.queueAction(this.playerId, { action: 'pickup' });
    }

    if (shouldShoot) {
      engine.queueAction(this.playerId, { action: 'shoot', aimAngle: aimAngleDeg });
    } else if (shouldMelee) {
      // Face the target before melee
      engine.queueAction(this.playerId, { action: 'move', angle: aimAngleDeg });
      engine.queueAction(this.playerId, { action: 'melee' });
    }

    if (moveAngleDeg !== null) {
      engine.queueAction(this.playerId, { action: 'move', angle: moveAngleDeg });
    } else {
      engine.queueAction(this.playerId, { action: 'stop' });
    }
  }

  // ── World awareness helpers ─────────────────────────────────────

  private getAllEnemies(match: ShooterMatch, me: ShooterPlayer): EnemyInfo[] {
    const result: EnemyInfo[] = [];
    for (const p of match.players.values()) {
      if (p.id === me.id || !p.alive || p.eliminated) continue;
      const dx = p.x - me.x;
      const dz = p.z - me.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const angleDeg = (Math.atan2(dz, dx) * 180) / Math.PI;
      result.push({
        id: p.id,
        x: p.x,
        z: p.z,
        distance: dist,
        angleDeg,
        health: p.health,
        lives: p.lives,
        weapon: p.weapon,
        alive: p.alive,
      });
    }
    result.sort((a, b) => a.distance - b.distance);
    return result;
  }

  private getAllPickups(match: ShooterMatch, me: ShooterPlayer): PickupInfo[] {
    const result: PickupInfo[] = [];
    for (const p of match.pickups) {
      if (p.taken) continue;
      const dx = p.x - me.x;
      const dz = p.z - me.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const angleDeg = (Math.atan2(dz, dx) * 180) / Math.PI;
      result.push({
        id: p.id,
        type: p.type,
        x: p.x,
        z: p.z,
        distance: dist,
        angleDeg,
      });
    }
    result.sort((a, b) => a.distance - b.distance);
    return result;
  }

  /**
   * Select target: when someone is nearby (within detectRadius), prefer by distance then health then weapon.
   * When no one is nearby, prefer lowest health or knife (easy kill) then move toward them.
   */
  private selectTarget(
    allEnemies: EnemyInfo[],
    now: number,
    excludeId?: string | null,
    detectRadius?: number,
  ): EnemyInfo | null {
    let list = allEnemies;

    const excludeUntil = this.engagement.noLOSExcludeUntil;
    if (Object.keys(excludeUntil).length > 0) {
      list = list.filter((e) => (excludeUntil[e.id] ?? 0) <= now);
    }

    if (excludeId && list.length > 1) {
      list = list.filter((e) => e.id !== excludeId);
    }

    if (list.length === 0) return null;

    const radius = detectRadius ?? 80;
    const nearby = list.filter((e) => e.distance < radius);
    const far = list.filter((e) => e.distance >= radius);

    if (nearby.length > 0) {
      const sorted = [...nearby].sort((a, b) => {
        if (Math.abs(a.distance - b.distance) > 2) return a.distance - b.distance;
        if (a.health !== b.health) return a.health - b.health;
        return (WEAPON_TIER[a.weapon] ?? 0) - (WEAPON_TIER[b.weapon] ?? 0);
      });
      return sorted[0];
    }

    if (far.length > 0) {
      const sorted = [...far].sort((a, b) => {
        if (a.health !== b.health) return a.health - b.health;
        const tierA = WEAPON_TIER[a.weapon] ?? 0;
        const tierB = WEAPON_TIER[b.weapon] ?? 0;
        if (tierA !== tierB) return tierA - tierB;
        return a.distance - b.distance;
      });
      return sorted[0];
    }

    return null;
  }

  // ── Stuck detection & recovery ──────────────────────────────────

  private updateStuckDetection(
    player: ShooterPlayer,
    target: EnemyInfo | null,
    allEnemies: EnemyInfo[],
    engine: ShooterEngine,
    now: number,
  ): void {
    if (now - this.lastStuckCheckTime < BOT_STUCK_CHECK_INTERVAL_MS) return;
    this.lastStuckCheckTime = now;

    if (this.lastStuckPos) {
      const dx = player.x - this.lastStuckPos.x;
      const dz = player.z - this.lastStuckPos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < BOT_STUCK_DISTANCE_THRESHOLD) {
        this.stuckAccumMs += BOT_STUCK_CHECK_INTERVAL_MS;
      } else {
        this.stuckAccumMs = 0;
        this.recovery.active = false;
      }
    }
    this.lastStuckPos = { x: player.x, z: player.z };

    // Check if clearly not stuck
    if (this.lastStuckPos) {
      const dx = player.x - this.lastStuckPos.x;
      const dz = player.z - this.lastStuckPos.z;
      if (Math.sqrt(dx * dx + dz * dz) >= BOT_STUCK_DISTANCE_THRESHOLD) {
        this.stuckConsecutiveCount = 0;
      }
    }

    if (this.stuckAccumMs >= BOT_STUCK_TIME_THRESHOLD_MS && !this.recovery.active) {
      // Switch to another target if stuck with current one
      if (target && allEnemies.length > 1) {
        const newTarget = this.selectTarget(allEnemies, now, target.id, BOT_TARGET_NO_LIMIT);
        if (newTarget) {
          this.engagement = {
            ...this.engagement,
            targetId: newTarget.id,
            startTime: now,
            lastDist: newTarget.distance,
            lastCheckTime: now,
          };
        }
      }

      this.stuckConsecutiveCount = Math.min(2, this.stuckConsecutiveCount + 1);
      const durationIndex = Math.min(this.stuckConsecutiveCount, BOT_STUCK_RECOVERY_DURATIONS.length - 1);
      const duration = BOT_STUCK_RECOVERY_DURATIONS[durationIndex];

      // Choose a recovery direction: perpendicular to target, alternating sides
      let preferredAngle = this.lastMoveAngleDeg;
      if (target) {
        const side = (this.recoveryQuadrant % 2 === 0) ? 1 : -1;
        preferredAngle = target.angleDeg + 90 * side;
        this.recoveryQuadrant++;
      }

      const recoveryAngle = engine.findLongestClearDirection(
        player.x, player.z, preferredAngle,
        BOT_OBSTACLE_LOOKAHEAD * 2.5, this.playerId,
      );

      this.recovery = { active: true, angleDeg: recoveryAngle, until: now + duration };
      this.stuckAccumMs = 0;
    }
  }

  /** Reset transient state on respawn. */
  resetOnRespawn(): void {
    this.stuckAccumMs = 0;
    this.stuckConsecutiveCount = 0;
    this.recovery = { active: false, angleDeg: 0, until: 0 };
    this.lastStuckPos = null;
    this.lastPosition = null;
    this.forceWanderUntil = 0;
    this.forceTurnUntil = 0;
    this.moveAngleSamples = [];
    this.engagement = {
      targetId: null,
      startTime: 0,
      lastDist: Infinity,
      lastCheckTime: 0,
      noLOSExcludeUntil: {},
    };
    this.noLOSPath = { angleDeg: 0, until: 0 };
    this.noLOSSince = 0;
    this.forceStandoffUntil = 0;
    this.cachedAvoidDir = { angleDeg: 0, until: 0 };
    this.goalCommitment = { type: null, until: 0, targetId: null };
  }
}

// ── BotAIManager: manages all AI bots in a match ──────────────────

export class BotAIManager {
  private brains: Map<string, BotBrain> = new Map();

  /** Register a new AI bot brain. */
  addBot(playerId: string, personality: PersonalityType): void {
    this.brains.set(playerId, new BotBrain(playerId, personality));
  }

  /** Remove an AI bot (e.g. when replaced by an API agent). */
  removeBot(playerId: string): void {
    this.brains.delete(playerId);
  }

  /** Get brain for a specific bot. */
  getBrain(playerId: string): BotBrain | undefined {
    return this.brains.get(playerId);
  }

  /** Get all bot IDs managed by this AI manager. */
  getBotIds(): string[] {
    return [...this.brains.keys()];
  }

  /** Number of AI bots currently managed. */
  get size(): number {
    return this.brains.size;
  }

  /** Clear all brains (on match reset). */
  clear(): void {
    this.brains.clear();
  }

  /**
   * Run one tick for all AI bots.
   * Called by the engine's onPreTick hook.
   */
  tick(match: ShooterMatch, engine: ShooterEngine): void {
    if (match.phase !== 'active') return;

    for (const brain of this.brains.values()) {
      try {
        brain.tick(match, engine);
      } catch (err) {
        console.error(`[BotAI] Error ticking bot ${brain.playerId}:`, err);
      }
    }
  }
}
