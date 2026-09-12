/// <reference path="puerts.d.ts" />
declare module "ue" {
    import * as cpp from "cpp"

    class Plane extends UE.Vector {
        X: number;
        Y: number;
    }

    class Actor extends UE.Object {
        SetActorLocation(p0: UE.Vector): boolean;
    }
    enum EMovementMode {
        MOVE_None = 0,
        MOVE_Walking = 1,
    }
}

