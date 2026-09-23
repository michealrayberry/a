using System;
using HarmonyLib;
using UnityEngine;

namespace HardcoreCartography
{
    /// <summary>
    /// Vanilla gates the whole minimap on <c>Game.m_noMap</c>. Instead of fighting every check,
    /// we clear that flag while Minimap runs its own logic (so exploration and pins keep working)
    /// and decide ourselves which map mode is allowed in <c>SetMapMode</c>.
    /// Worlds without the no-map modifier are left completely alone.
    /// </summary>
    internal static class MinimapPatches
    {
        private static int _suppressDepth;
        private static bool _savedNoMap;
        private static float _nextCheck;
        private static float _nextMessage;

        private static AccessTools.FieldRef<Minimap, Minimap.MapMode> _mode;

        /// <summary>True when the world really is a no-map world, even while we have the flag cleared.</summary>
        internal static bool WorldHasNoMap => _suppressDepth > 0 ? _savedNoMap : Game.m_noMap;

        public static void Apply(Harmony harmony)
        {
            _mode = AccessTools.FieldRefAccess<Minimap, Minimap.MapMode>("m_mode");

            var setMapMode = AccessTools.Method(typeof(Minimap), "SetMapMode", new[] { typeof(Minimap.MapMode) });
            var update = AccessTools.Method(typeof(Minimap), "Update");
            if (setMapMode == null || update == null)
            {
                Jotunn.Logger.LogError("Minimap.SetMapMode/Update not found - game update changed them. Mod disabled.");
                return;
            }

            harmony.Patch(setMapMode,
                prefix: new HarmonyMethod(typeof(MinimapPatches), nameof(SetMapModePrefix)),
                finalizer: new HarmonyMethod(typeof(MinimapPatches), nameof(RestoreFinalizer)));

            harmony.Patch(update,
                prefix: new HarmonyMethod(typeof(MinimapPatches), nameof(SuppressPrefix)),
                postfix: new HarmonyMethod(typeof(MinimapPatches), nameof(UpdatePostfix)),
                finalizer: new HarmonyMethod(typeof(MinimapPatches), nameof(RestoreFinalizer)));

            // Not every game version has a LateUpdate here; patch it only if present.
            var lateUpdate = AccessTools.DeclaredMethod(typeof(Minimap), "LateUpdate");
            if (lateUpdate != null)
            {
                harmony.Patch(lateUpdate,
                    prefix: new HarmonyMethod(typeof(MinimapPatches), nameof(SuppressPrefix)),
                    finalizer: new HarmonyMethod(typeof(MinimapPatches), nameof(RestoreFinalizer)));
            }
        }

        private static void Suppress()
        {
            if (_suppressDepth++ == 0)
            {
                _savedNoMap = Game.m_noMap;
                Game.m_noMap = false;
            }
        }

        private static void Restore()
        {
            if (_suppressDepth > 0 && --_suppressDepth == 0)
            {
                Game.m_noMap = _savedNoMap;
            }
        }

        private static void SuppressPrefix(ref bool __state)
        {
            if (WorldHasNoMap)
            {
                Suppress();
                __state = true;
            }
        }

        // Finalizer so the flag is always put back, even if vanilla throws mid-frame.
        private static Exception RestoreFinalizer(Exception __exception, bool __state)
        {
            if (__state)
            {
                Restore();
            }
            return __exception;
        }

        private static void SetMapModePrefix(ref Minimap.MapMode __0, ref bool __state)
        {
            if (!WorldHasNoMap || __0 == Minimap.MapMode.None)
            {
                return;
            }

            var player = Player.m_localPlayer;
            string reason = null;
            bool allowed = player && MapAccess.CanOpen(player, out reason);

            if (__0 == Minimap.MapMode.Small)
            {
                // Vanilla requests the minimap every frame; never nag about it.
                allowed &= Plugin.AllowMinimap.Value;
                reason = null;
            }

            if (allowed)
            {
                Suppress();
                __state = true;
            }
            else
            {
                __0 = Minimap.MapMode.None;
                if (player && reason != null)
                {
                    Notify(player, reason);
                }
            }
        }

        private static void UpdatePostfix(Minimap __instance)
        {
            if (!WorldHasNoMap || Time.time < _nextCheck)
            {
                return;
            }
            _nextCheck = Time.time + 0.5f;

            var player = Player.m_localPlayer;
            var mode = _mode(__instance);
            if (!player || mode == Minimap.MapMode.None)
            {
                return;
            }

            // Walked out of the base (or dropped the chart) with the map open: roll it up.
            if (!MapAccess.CanOpen(player, out string reason))
            {
                __instance.SetMapMode(Minimap.MapMode.None);
                if (mode == Minimap.MapMode.Large && reason != null)
                {
                    Notify(player, reason);
                }
            }
        }

        private static void Notify(Player player, string message)
        {
            if (Time.time < _nextMessage)
            {
                return;
            }
            _nextMessage = Time.time + 2f;
            player.Message(MessageHud.MessageType.Center, message);
        }
    }
}
