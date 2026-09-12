/// <reference path="puerts.d.ts" />
declare module "ue" {
    import * as cpp from "cpp"

    namespace Game.TopDown.Blueprints {

        class BP_TopDownCharacter_C extends UE.Actor {
            Health: number;
        }

// __TYPE_DECL_START: 5.7
    namespace Game.TopDown.Blueprints {
        class BP_Boss_C extends UE.Actor {
        }

    }
// __TYPE_DECL_END
// __TYPE_DECL_START: ASSOCIATION
    namespace Game.PythonTypes {
        enum EPyKind {
            A = 0,
        }

    }
// __TYPE_DECL_END
// __TYPE_DECL_START: 5.7
    namespace Engine.PythonTypes {
        class FPyObject {
        }

    }
// __TYPE_DECL_END
}

