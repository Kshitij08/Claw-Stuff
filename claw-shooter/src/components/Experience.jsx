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
} from "../constants/weapons";

const getRandomCharacter = () => {
  const characters = ["Bond", "Bambo", "Steve", "Zombie"];
  return characters[Math.floor(Math.random() * characters.length)];
};

export const Experience = ({ downgradedPerformance = false }) => {
  const [players, setPlayers] = useState([]);
  const [bullets, setBullets] = useState([]);
  const [networkBullets, setNetworkBullets] = useMultiplayerState("bullets", []);
  const [hits, setHits] = useState([]);
  const [networkHits, setNetworkHits] = useMultiplayerState("hits", []);
  const spawnPositionsRef = useRef([]);
  const botNameIndexRef = useRef(0);
  const hasStartedRef = useRef(false);
  const botsAddedRef = useRef(0);
  const pickupsSpawnedRef = useRef(false);
  const { weaponPickups, takePickup, spawnWeaponPickups, checkWinCondition, gamePhase } =
    useGameManager();
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    setNetworkBullets(bullets);
  }, [bullets]);

  useEffect(() => {
    setNetworkHits(hits);
  }, [hits]);

  /* Spawn weapon pickups once when gamePhase transitions to "playing" */
  useEffect(() => {
    if (gamePhase === "playing" && !pickupsSpawnedRef.current && isHost()) {
      pickupsSpawnedRef.current = true;
      if (spawnPositionsRef.current.length > 0) {
        spawnWeaponPickups(spawnPositionsRef.current);
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

  useEffect(() => {
    const spawns = [];
    for (let i = 0; i < 1000; i++) {
      const obj = scene.getObjectByName(`spawn_${i}`);
      if (obj) spawns.push(new Vector3().copy(obj.position));
      else break;
    }
    if (spawns.length === 0) {
      for (let i = 0; i < 20; i++) {
        spawns.push(
          new Vector3(
            (Math.random() - 0.5) * 80,
            0,
            (Math.random() - 0.5) * 80
          )
        );
      }
    }
    spawnPositionsRef.current = spawns;
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
        if (state.getState("character") === undefined)
          state.setState("character", getRandomCharacter());
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
            downgradedPerformance={downgradedPerformance}
            getSpawnPositions={() => spawnPositionsRef.current}
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
