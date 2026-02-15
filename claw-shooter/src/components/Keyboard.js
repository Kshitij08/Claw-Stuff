class Keyboard {
  constructor(state, isUserPlayer) {
    if (state.isBot()) return;
    this.playerState = state;
    this.isUserPlayer = isUserPlayer;
    this.keyPressHooks = {
      w: false,
      a: false,
      s: false,
      d: false,
      //space bar
      " ": false,
    };
    this.keyDownHandler = this.keyDownHandler.bind(this);
    this.keyUpHandler = this.keyUpHandler.bind(this);
    this.mouseDownHandler = this.mouseDownHandler.bind(this);
    this.mouseUpHandler = this.mouseUpHandler.bind(this);

    this.addEventListeners();
    console.log("Keyboard initialized");
  }

  addEventListeners() {
    window.addEventListener("keydown", this.keyDownHandler);
    window.addEventListener("keyup", this.keyUpHandler);
    window.addEventListener("mousedown", this.mouseDownHandler);
    window.addEventListener("mouseup", this.mouseUpHandler);
  }

  removeEventListeners() {
    window.removeEventListener("keydown", this.keyDownHandler);
    window.removeEventListener("keyup", this.keyUpHandler);
    window.removeEventListener("mousedown", this.mouseDownHandler);
    window.removeEventListener("mouseup", this.mouseUpHandler);
  }

  keyDownHandler(event) {
    if (!this.isUserPlayer) return;

    const key = event.key.toLowerCase();
    if (this.keyPressHooks[key] !== undefined) {
      if (key === " ") {
        this.playerState.setState("ctr-fire", true);
        return;
      }

      if (this.playerState.getState("useJoystick")) return;

      this.playerState.setState("ctr-keyboard", true);
      this.keyPressHooks[key] = true;
      this.playerState.setState("ctr-" + key, true);
      this.updateAngle();
    }
  }

  keyUpHandler(event) {
    if (!this.isUserPlayer) return;

    const key = event.key.toLowerCase();
    if (this.keyPressHooks[key] !== undefined) {
      if (key === " ") {
        this.playerState.setState("ctr-fire", false);
        return;
      }
      this.keyPressHooks[key] = false;
      this.playerState.setState("ctr-" + key, false);
      this.updateAngle();
    }

    // If no keys are pressed, stop the player
    if (!this.isAnyKeyPressed()) {
      this.playerState.setState("ctr-keyboard", false);
    }
  }

  mouseDownHandler(event) {
    if (!this.isUserPlayer || event.button !== 0) return;
    this.playerState.setState("ctr-fire", true);
  }

  mouseUpHandler(event) {
    if (!this.isUserPlayer || event.button !== 0) return;
    this.playerState.setState("ctr-fire", false);
  }

  kbAngle() {
    return this.playerState.getState("ctr-keyboard-angle") || 0;
  }

  updateAngle() {
    let angle = this.kbAngle();
    if (
      this.keyPressHooks.w &&
      !this.keyPressHooks.a &&
      !this.keyPressHooks.d
    ) {
      angle = Math.PI;
    } else if (
      this.keyPressHooks.a &&
      !this.keyPressHooks.w &&
      !this.keyPressHooks.s
    ) {
      angle = Math.PI * 1.5;
    } else if (
      this.keyPressHooks.s &&
      !this.keyPressHooks.a &&
      !this.keyPressHooks.d
    ) {
      angle = Math.PI * 2;
    } else if (
      this.keyPressHooks.d &&
      !this.keyPressHooks.w &&
      !this.keyPressHooks.s
    ) {
      angle = Math.PI / 2;
    } else if (this.keyPressHooks.s && this.keyPressHooks.a) {
      angle = Math.PI * 1.75;
    } else if (this.keyPressHooks.w && this.keyPressHooks.a) {
      angle = Math.PI * 1.25;
    } else if (this.keyPressHooks.w && this.keyPressHooks.d) {
      angle = Math.PI * 0.75;
    } else if (this.keyPressHooks.s && this.keyPressHooks.d) {
      angle = Math.PI * 0.25;
    }
    this.playerState.setState("ctr-keyboard-angle", angle);
  }

  isKeyPressed(key) {
    return this.keyPressHooks[key];
  }

  isAnyKeyPressed() {
    const movementKeys = ["w", "a", "s", "d"];
    return movementKeys.some((key) => this.playerState.getState("ctr-" + key));
  }
}

export default Keyboard;
