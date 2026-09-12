/*
* Copyright (C) 2020 Tencent.
*/
declare module "ue" {
    namespace ue {
        const uclass: Function;
        const ufunction: Function;
    }
    function set_flags(): void;
    function clear_flags(): void;
    type BuiltinBool = 0;
    const BuiltinBool = 0;
    abstract class FFloat16Color {
    }
}

