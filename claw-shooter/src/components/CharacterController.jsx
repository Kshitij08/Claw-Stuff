import { useEffect, useRef, useState } from "react";
import { CharacterSoldier } from "./CharacterSoldier";
import { CharacterPlayer } from "./CharacterPlayer";
import { CapsuleCollider, RigidBody, vec3 } from "@react-three/rapier";
import { useFrame, useThree } from "@react-three/fiber";
import { isHost } from "playroomkit";
import { Billboard, CameraControls, Text } from "@react-three/drei";

const MOVEMENT_SPEED = 200;
const FIRE_RATE = 380;

// FOR CHARACTER PLAYER
export const WEAPON_OFFSET = {
  x: -0.4,
  y: 2.0,
  z: 1.0,
};
// FOR CHARACTER SOLDIER
// export const WEAPON_OFFSET = {
//   x: -0.2,
//   y: 1.4,
//   z: 0.8,
// };

// Disable CameraControls mouse buttons and touch events
const mouseButtons = {
  left: 0,
  right: 0,
  middle: 0,
  wheel: 0,
};
const touches = {
  one: 0,
  two: 0,
  three: 0,
};

export const CharacterController = ({
  state,
  joystick,
  keyboard,
  userPlayer,
  onFire,
  onKilled,
  downgradedPerformance,
  useJoystick,
  ...props
}) => {
  const group = useRef();
  const character = useRef();
  const rigidbody = useRef();
  const controls = useRef();
  const lastShoot = useRef(0);
  const directionalLight = useRef();
  const [animation, setAnimation] = useState("Idle");

  const scene = useThree((state) => state.scene);

  const spawnRandomly = () => {
    const spawns = [];
    for (let i = 0; i < 1000; i++) {
      // Search for an object in glb file with the name "spawn_<number>"
      const spawn = scene.getObjectByName(`spawn_${i}`);
      if (spawn) spawns.push(spawn);
      else break;
    }
    const randomSpawn =
      spawns[Math.floor(Math.random() * spawns.length)].position;
    rigidbody.current.setTranslation(randomSpawn);
  };

  useEffect(() => {
    if (isHost()) {
      spawnRandomly();
    }
  }, []);

  useEffect(() => {
    if (state.state.dead) {
      const audio = new Audio("/sounds/death.mp3");
      audio.volume = 0.5;
      audio.play();
    }
  }, [state.state.dead]);

  useEffect(() => {
    if (character.current && userPlayer) {
      directionalLight.current.target = character.current;
    }
  }, [character.current]);

  useEffect(() => {
    if (userPlayer) {
      state.setState("useJoystick", useJoystick);
      // Get last angle from mouse
      state.setState("ctr-angle", state.getState("ctr-mouse-angle"));
    }
  }, [useJoystick]);

  useFrame(({ mouse, viewport }, delta) => {
    // If there is no rigidbody, return
    if (!rigidbody.current) return;

    // Camera follow
    if (controls.current) {
      const cameraDistanceY = window.innerWidth < 1024 ? 16 : 20;
      const cameraDistanceZ = window.innerWidth < 1024 ? 12 : 16;
      const playerWorldPos = vec3(rigidbody.current.translation());
      controls.current.setLookAt(
        playerWorldPos.x,
        playerWorldPos.y + (state.state.dead ? 12 : cameraDistanceY),
        playerWorldPos.z + (state.state.dead ? 2 : cameraDistanceZ),
        playerWorldPos.x,
        playerWorldPos.y + 1.5,
        playerWorldPos.z,
        true
      );
    }

    // If player is dead, play death sfx & animation
    if (state.state.dead) {
      setAnimation("Death");
      return;
    }

    if (!state.getState("useJoystick") && userPlayer) {
      const x = (mouse.x * viewport.width) / 2.5;
      const y = (mouse.y * viewport.height) / 2.5;
      const lookAngle = -Math.atan2(x, y) + Math.PI;
      state.setState("ctr-mouse-angle", lookAngle);
    }

    // Update player position based on joystick state or keyboard input
    const joystickAngle = joystick.angle();
    const mouseAngle = state.getState("ctr-mouse-angle");
    const moveAngle = keyboard.kbAngle();
    if (joystick.isJoystickPressed() && joystickAngle) {
      setAnimation("Run");
      character.current.rotation.y = joystickAngle;
      const impulse = {
        x: Math.sin(joystickAngle) * MOVEMENT_SPEED * delta,
        y: 0,
        z: Math.cos(joystickAngle) * MOVEMENT_SPEED * delta,
      };
      rigidbody.current.wakeUp();
      rigidbody.current.applyImpulse(impulse);
    } else if (keyboard.isAnyKeyPressed()) {
      setAnimation("Run");
      character.current.rotation.y = mouseAngle;
      const impulse = {
        x: Math.sin(moveAngle) * MOVEMENT_SPEED * delta,
        y: 0,
        z: Math.cos(moveAngle) * MOVEMENT_SPEED * delta,
      };
      rigidbody.current.wakeUp();
      rigidbody.current.applyImpulse(impulse);
    } else {
      setAnimation("Idle");
      if (!state.getState("useJoystick"))
        character.current.rotation.y = mouseAngle;
    }

    if (isHost()) {
      // Sync player position
      state.setState("pos", rigidbody.current.translation());
    } else {
      // Update player position based on host state
      const pos = state.getState("pos");
      if (pos) rigidbody.current.setTranslation(pos);
    }

    // Check if fire button is pressed
    if (joystick.isPressed("fire")) {
      // fire
      if (
        (joystick.isJoystickPressed() && joystickAngle) ||
        keyboard.isAnyKeyPressed()
      )
        setAnimation("Run_Shoot");
      else setAnimation("Idle_Shoot");
      if (isHost()) {
        if (Date.now() - lastShoot.current > FIRE_RATE) {
          lastShoot.current = Date.now();
          const newBullet = {
            id: state.id + "-" + +new Date(),
            position: vec3(rigidbody.current.translation()),
            angle:
              joystick.isJoystickPressed() || state.getState("useJoystick")
                ? joystickAngle
                : mouseAngle,
            player: state.id,
          };
          onFire(newBullet);
        }
      }
    }
  });

  return (
    <group ref={group} {...props}>
      {userPlayer && (
        <CameraControls
          ref={controls}
          mouseButtons={mouseButtons}
          touches={touches}
        />
      )}
      <RigidBody
        ref={rigidbody}
        colliders={false}
        linearDamping={12}
        lockRotations
        type={isHost() ? "dynamic" : "kinematicPosition"}
        onIntersectionEnter={({ other }) => {
          if (
            isHost() &&
            other.rigidBody.userData?.type === "bullet" &&
            state.state.health > 0
          ) {
            const newHealth =
              state.state.health - other.rigidBody.userData.damage;
            if (newHealth <= 0) {
              state.setState("dead", true);
              state.setState("deaths", state.state.deaths + 1);
              state.setState("health", 0);
              rigidbody.current.setEnabled(false);
              setTimeout(() => {
                spawnRandomly();
                state.setState("dead", false);
                state.setState("health", 100);
                rigidbody.current.setEnabled(true);
              }, 2000);
              onKilled(state.id, other.rigidBody.userData.player);
            } else {
              state.setState("health", newHealth);
            }
          }
        }}
        userData={{
          type: "player",
        }}
      >
        <PlayerInfo state={state.state} />
        <group ref={character}>
          <CharacterPlayer
            animation={animation}
            character={state.getState("character")}
          />
          {/* <CharacterSoldier 
            color={state.state.profile?.color}
            animation={animation}
          /> */}
          {userPlayer && (
            <Crosshair
              position={[WEAPON_OFFSET.x, WEAPON_OFFSET.y, WEAPON_OFFSET.z]}
            />
          )}
        </group>
        {userPlayer && (
          // Add a light to follow the user player
          // This will only calculate not all shadows but
          // only the shadows that are visible to the camera
          <directionalLight
            ref={directionalLight}
            position={[25, 18, -25]}
            intensity={0.3}
            castShadow={!downgradedPerformance} // Disable shadows on low-end devices
            shadow-camera-near={0}
            shadow-camera-far={100}
            shadow-camera-left={-20}
            shadow-camera-right={20}
            shadow-camera-top={20}
            shadow-camera-bottom={-20}
            shadow-mapSize-width={2048}
            shadow-mapSize-height={2048}
            shadow-bias={-0.0001}
          />
        )}
        <CapsuleCollider args={[0.7, 0.66]} position={[0, 1.28, 0]} />
      </RigidBody>
    </group>
  );
};

const Crosshair = (props) => {
  return (
    <group {...props}>
      <mesh position-z={1}>
        <boxGeometry args={[0.05, 0.05, 0.05]} />
        <meshBasicMaterial color="black" transparent opacity={0.9} />
      </mesh>
      <mesh position-z={2}>
        <boxGeometry args={[0.05, 0.05, 0.05]} />
        <meshBasicMaterial color="black" transparent opacity={0.85} />
      </mesh>
      <mesh position-z={3}>
        <boxGeometry args={[0.05, 0.05, 0.05]} />
        <meshBasicMaterial color="black" transparent opacity={0.8} />
      </mesh>

      <mesh position-z={4.5}>
        <boxGeometry args={[0.05, 0.05, 0.05]} />
        <meshBasicMaterial color="black" opacity={0.7} transparent />
      </mesh>

      <mesh position-z={6.5}>
        <boxGeometry args={[0.05, 0.05, 0.05]} />
        <meshBasicMaterial color="black" opacity={0.6} transparent />
      </mesh>

      <mesh position-z={9}>
        <boxGeometry args={[0.05, 0.05, 0.05]} />
        <meshBasicMaterial color="black" opacity={0.2} transparent />
      </mesh>
    </group>
  );
};

const PlayerInfo = ({ state }) => {
  const health = state.health;
  const name = state.profile.name;
  return (
    <Billboard position-y={2.5}>
      <Text position-y={0.36} fontSize={0.4}>
        {name}
        <meshBasicMaterial color={state.profile.color} />
      </Text>
      <mesh position-z={-0.1}>
        <planeGeometry args={[1, 0.2]} />
        <meshBasicMaterial color="black" transparent opacity={0.5} />
      </mesh>
      <mesh scale-x={health / 100} position-x={-0.5 * (1 - health / 100)}>
        <planeGeometry args={[1, 0.2]} />
        <meshBasicMaterial color="red" />
      </mesh>
    </Billboard>
  );
};
