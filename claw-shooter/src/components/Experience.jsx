import { Environment } from "@react-three/drei";
import { Map } from "./Map";
import { useEffect, useState, useRef } from "react";
import {
  insertCoin,
  isHost,
  onPlayerJoin,
  useMultiplayerState,
  addBot,
} from "playroomkit";
import { Bullet } from "./Bullet";
import { BulletHit } from "./BulletHit";
import { BotController, PlayerBot } from "./BotController";
import { WeaponPickup } from "./WeaponPickup";
import { useGameManager } from "./GameManager";
import { useFrame, useThree } from "@react-three/fiber";
import { Vector3 } from "three";
import {
  BOT_NAMES,
  PERSONALITIES,
  LIVES_PER_BOT,
  HEALTH_PER_LIFE,
  WEAPON_TYPES,
  PLAYER_COUNT,
  MAP_BOUNDS,
  MIN_DISTANCE_GUN_FROM_PLAYER_SPAWN,
} from "../constants/weapons";

const DEFAULT_CHARACTER = "G_1";
/** Bot skins: G_1.glb through G_10.glb */
const BOT_CHARACTERS = Array.from({ length: 10 }, (_, i) => `G_${i + 1}`);

export const Experience = ({ downgradedPerformance = false }) => {
  const [players, setPlayers] = useState([]);
  const [bullets, setBullets] = useState([]);
  const [networkBullets, setNetworkBullets] = useMultiplayerState("bullets", []);
  const [hits, setHits] = useState([]);
  const [networkHits, setNetworkHits] = useMultiplayerState("hits", []);
  const spawnPositionsRef = useRef([]);
  const modelSpawnPositionsRef = useRef([]);
  const gunSpawnPositionsRef = useRef([]);
  const [playerSpawnMarkers, setPlayerSpawnMarkers] = useState([]);
  const refreshCountRef = useRef(0);
  const botNameIndexRef = useRef(0);
  const hasStartedRef = useRef(false);
  const botsAddedRef = useRef(0);
  const pickupsSpawnedRef = useRef(false);
  const { weaponPickups, takePickup, addWeaponPickup, spawnWeaponPickups, checkWinCondition, gamePhase } =
    useGameManager();
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    setNetworkBullets(bullets);
  }, [bullets]);

  useEffect(() => {
    setNetworkHits(hits);
  }, [hits]);

  /* Spawn weapon pickups once when gamePhase transitions to "playing" (at gun spawn points) */
  useEffect(() => {
    if (gamePhase === "playing" && !pickupsSpawnedRef.current && isHost()) {
      pickupsSpawnedRef.current = true;
      const gunSpawns = gunSpawnPositionsRef.current;
      const positions = gunSpawns.length > 0 ? gunSpawns : spawnPositionsRef.current;
      if (positions.length > 0) {
        spawnWeaponPickups(positions);
      }
    }
  }, [gamePhase]);

  const onFire = (bullet) => {
    setBullets((b) => [...b, bullet]);
  };

  const onHit = (bulletId, position, type) => {
    setBullets((b) => b.filter((bullet) => bullet.id !== bulletId));
    setHits((h) => [...h, { id: bulletId, position, type }]);
  };

  const onHitEnded = (hitId) => {
    setHits((h) => h.filter((hit) => hit.id !== hitId));
  };

  const onKilled = (_victimId, killerId) => {
    const killer = players.find((p) => p.state?.id === killerId);
    if (killer?.state) {
      killer.state.setState("kills", (killer.state.state.kills || 0) + 1);
    }
  };

  const onMeleeHit = (victimId, attackerId, damage) => {
    const victim = players.find((p) => p.state?.id === victimId);
    if (!victim?.state || !isHost()) return;
    const currentHealth = victim.state.state?.health ?? 100;
    const newHealth = currentHealth - damage;
    victim.state.setState("lastDamageTime", Date.now());
    if (newHealth <= 0) {
      victim.state.setState("dead", true);
      victim.state.setState("deaths", (victim.state.state?.deaths || 0) + 1);
      victim.state.setState("health", 0);
      const lives = (victim.state.state?.lives ?? LIVES_PER_BOT) - 1;
      victim.state.setState("lives", lives);
      if (lives <= 0) victim.state.setState("eliminated", true);
      onKilled(victimId, attackerId);
    } else {
      victim.state.setState("health", newHealth);
    }
  };

  const onWeaponPickup = (pickupId) => {
    takePickup(pickupId);
  };

  const onWeaponDrop = (weaponType) => {
    addWeaponPickup(weaponType);
  };

  /* map.glb: use spawn positions as-is (world space), no offset or remap. */
  const _worldPos = useRef(new Vector3());
  const refreshSpawnPositions = () => {
    const collectByName1BasedWorld = (prefix, max = 1000) => {
      const out = [];
      const w = _worldPos.current;
      for (let i = 1; i <= max; i++) {
        const obj = scene.getObjectByName(`${prefix}${i}`);
        if (obj) {
          obj.getWorldPosition(w);
          out.push(w.clone());
        } else {
          if (i === 1) {
            const obj0 = scene.getObjectByName(`${prefix}0`);
            if (obj0) {
              obj0.getWorldPosition(w);
              out.push(w.clone());
            }
          }
          break;
        }
      }
      return out;
    };
    const collectByName0BasedWorld = (prefix, max = 1000) => {
      const out = [];
      const w = _worldPos.current;
      for (let i = 0; i < max; i++) {
        const obj = scene.getObjectByName(`${prefix}${i}`);
        if (obj) {
          obj.getWorldPosition(w);
          out.push(w.clone());
        } else break;
      }
      return out;
    };

    let modelSpawns = collectByName1BasedWorld("player_spawn_");
    if (modelSpawns.length === 0) modelSpawns = collectByName0BasedWorld("spawn_");
    modelSpawnPositionsRef.current = modelSpawns;

    const need = Math.max(PLAYER_COUNT, 20);
    const fallback = [];
    for (let i = 0; i < need; i++) {
      fallback.push(
        new Vector3(
          MAP_BOUNDS.minX + Math.random() * (MAP_BOUNDS.maxX - MAP_BOUNDS.minX),
          0,
          MAP_BOUNDS.minZ + Math.random() * (MAP_BOUNDS.maxZ - MAP_BOUNDS.minZ)
        )
      );
    }
    spawnPositionsRef.current =
      modelSpawns.length >= PLAYER_COUNT
        ? modelSpawns
        : modelSpawns.length > 0
          ? [...modelSpawns, ...fallback.slice(0, need - modelSpawns.length)]
          : fallback;

    const gunSpawns = collectByName1BasedWorld("gun_spawn_");
    if (gunSpawns.length === 0) {
      const gun0 = collectByName0BasedWorld("gun_spawn_");
      if (gun0.length > 0) {
        gunSpawnPositionsRef.current = gun0;
      } else {
        /* No gun_spawn_ in map: build positions away from player spawns so guns don't sit on bot spawns */
        const playerSpawns = spawnPositionsRef.current;
        const minDist = MIN_DISTANCE_GUN_FROM_PLAYER_SPAWN;
        const out = [];
        const need = Math.max(PLAYER_COUNT, 20);
        for (let tries = 0; out.length < need && tries < 200; tries++) {
          const v = new Vector3(
            MAP_BOUNDS.minX + Math.random() * (MAP_BOUNDS.maxX - MAP_BOUNDS.minX),
            0,
            MAP_BOUNDS.minZ + Math.random() * (MAP_BOUNDS.maxZ - MAP_BOUNDS.minZ)
          );
          const tooClose = playerSpawns.some((s) => {
            const sx = s.x ?? 0, sz = s.z ?? 0;
            return v.distanceTo(new Vector3(sx, 0, sz)) < minDist;
          });
          if (!tooClose) out.push(v.clone());
        }
        gunSpawnPositionsRef.current = out.length > 0 ? out : playerSpawns;
      }
    } else {
      gunSpawnPositionsRef.current = gunSpawns;
    }

    const forMarkers = spawnPositionsRef.current.map((p) =>
      p instanceof Vector3 ? p.clone() : new Vector3(p.x, p.y ?? 0, p.z)
    );
    setPlayerSpawnMarkers(forMarkers);
    refreshCountRef.current += 1;
    if (refreshCountRef.current <= 3 || modelSpawns.length > 0) {
      console.log("[Spawn] refresh:", {
        player: spawnPositionsRef.current.length,
        model: modelSpawns.length,
        gun: gunSpawnPositionsRef.current.length,
      });
    }
  };

  useEffect(() => {
    refreshSpawnPositions();
    /* Retry so we catch arena when it loads (useGLTF is async) */
    const t1 = setTimeout(refreshSpawnPositions, 200);
    const t2 = setTimeout(refreshSpawnPositions, 500);
    const t3 = setTimeout(refreshSpawnPositions, 1200);
    const t4 = setTimeout(refreshSpawnPositions, 2500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
    };
  }, [scene]);

  useEffect(() => {
    if (hasStartedRef.current) return;
    hasStartedRef.current = true;

    let mounted = true;

    const start = async () => {
      await insertCoin({
        skipLobby: true,
        enableBots: true,
        maxPlayersPerRoom: PLAYER_COUNT + 2,
        botOptions: {
          botClass: PlayerBot,
        },
      });

      if (!mounted) return;

      onPlayerJoin((state) => {
        state.setState("health", HEALTH_PER_LIFE);
        state.setState("deaths", 0);
        state.setState("kills", 0);
        state.setState("lives", LIVES_PER_BOT);
        state.setState("eliminated", false);
        state.setState("weapon", WEAPON_TYPES.KNIFE);
        state.setState("ammo", null);
        if (state.getState("character") === undefined) {
          state.setState(
            "character",
            state.isBot()
              ? BOT_CHARACTERS[Math.floor(Math.random() * BOT_CHARACTERS.length)]
              : DEFAULT_CHARACTER
          );
        }
        if (state.getState("personality") === undefined)
          state.setState(
            "personality",
            PERSONALITIES[Math.floor(Math.random() * PERSONALITIES.length)]
          );
        if (state.isBot()) {
          const idx = botNameIndexRef.current++ % BOT_NAMES.length;
          state.setState("profile", {
            ...(state.getState("profile") || {}),
            name: BOT_NAMES[idx],
            color: "#" + Math.floor(Math.random() * 16777215).toString(16),
          });
        }

        const newPlayer = { state };
        setPlayers((prev) => {
          if (prev.some((p) => p.state?.id === state.id)) return prev;
          return [...prev, newPlayer];
        });

        state.onQuit(() => {
          setPlayers((p) => p.filter((x) => x.state?.id !== state.id));
        });
      });

      if (isHost()) {
        for (let i = 0; i < PLAYER_COUNT; i++) {
          if (botsAddedRef.current >= PLAYER_COUNT) break;
          try {
            await addBot();
            botsAddedRef.current++;
          } catch (e) {
            console.warn("addBot", e);
          }
        }
      }
    };

    start();
    return () => {
      mounted = false;
    };
  }, []);

  const frameCountRef = useRef(0);
  useFrame(() => {
    frameCountRef.current += 1;
    if (frameCountRef.current <= 300 && frameCountRef.current % 15 === 0) {
      refreshSpawnPositions();
    }
  });

  /* Only check win condition for bots – the local spectator is not a participant */
  const botPlayers = players.filter((p) => p.state?.isBot?.());
  useFrame(() => {
    if (isHost() && botPlayers.length > 0 && gamePhase === "playing") {
      checkWinCondition(botPlayers);
    }
  });

  const allBullets = isHost() ? bullets : networkBullets;
  const allHits = isHost() ? hits : networkHits;

  return (
    <>
      <Map />
      {playerSpawnMarkers.map((pos, i) => (
        <group key={`spawn-marker-${i}`} position={[pos.x, pos.y, pos.z]} userData={{ spawnMarker: true }}>
          <mesh raycast={() => null}>
            <cylinderGeometry args={[0.5, 0.8, 1.2, 8]} />
            <meshBasicMaterial color="#00ff00" transparent opacity={0.85} />
          </mesh>
          <mesh position={[0, 1.5, 0]} raycast={() => null}>
            <coneGeometry args={[0.4, 0.8, 6]} />
            <meshBasicMaterial color="#00ff00" transparent opacity={0.9} />
          </mesh>
        </group>
      ))}
      {weaponPickups.map((p) => (
        <WeaponPickup
          key={p.id}
          id={p.id}
          weaponType={p.weaponType}
          position={p.position}
          taken={p.taken}
        />
      ))}
      {players
        .filter((p) => p.state?.isBot?.())
        .slice(0, PLAYER_COUNT)
        .map(({ state }, idx) => (
          <BotController
            key={state.id}
            state={state}
            spawnIndex={idx}
            onFire={onFire}
            onKilled={onKilled}
            onMeleeHit={onMeleeHit}
            onWeaponPickup={onWeaponPickup}
            onWeaponDrop={onWeaponDrop}
            downgradedPerformance={downgradedPerformance}
            getSpawnPositions={() => spawnPositionsRef.current}
            getModelSpawnPositions={() => modelSpawnPositionsRef.current}
          />
        ))}
      {allBullets.map((bullet) => (
        <Bullet
          key={bullet.id}
          {...bullet}
          weaponType={bullet.weaponType}
          onHit={(position, type) => onHit(bullet.id, position, type)}
        />
      ))}
      {allHits.map((hit) => (
        <BulletHit key={hit.id} {...hit} onEnded={() => onHitEnded(hit.id)} />
      ))}
      <Environment preset="sunset" />
    </>
  );
};
