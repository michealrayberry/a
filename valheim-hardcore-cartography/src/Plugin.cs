using BepInEx;
using BepInEx.Configuration;
using HarmonyLib;
using Jotunn.Configs;
using Jotunn.Entities;
using Jotunn.Managers;
using Jotunn.Utils;

namespace HardcoreCartography
{
    public enum BaseRequirement
    {
        /// <summary>Within range of the bed you claimed as your spawn point.</summary>
        Bed,
        /// <summary>Within build range of any workbench.</summary>
        Workbench,
        /// <summary>No location check; carrying the chart is enough.</summary>
        Anywhere
    }

    [BepInPlugin(ModGuid, ModName, ModVersion)]
    [BepInDependency(Jotunn.Main.ModGuid)]
    [NetworkCompatibility(CompatibilityLevel.EveryoneMustHaveMod, VersionStrictness.Minor)]
    [SynchronizationMode(AdminOnlyStrictness.IfOnServer)]
    internal class Plugin : BaseUnityPlugin
    {
        public const string ModGuid = "com.rayberry.hardcorecartography";
        public const string ModName = "HardcoreCartography";
        public const string ModVersion = "0.1.0";

        public const string ChartPrefabName = "HC_WayfindersChart";

        internal static Plugin Instance;

        internal static ConfigEntry<BaseRequirement> Requirement;
        internal static ConfigEntry<float> BaseRadius;
        internal static ConfigEntry<bool> RequireChart;
        internal static ConfigEntry<bool> AllowMinimap;
        internal static ConfigEntry<string> ChartRecipe;

        private Harmony _harmony;

        private void Awake()
        {
            Instance = this;
            BindConfig();

            PrefabManager.OnVanillaPrefabsAvailable += AddChart;

            _harmony = new Harmony(ModGuid);
            MinimapPatches.Apply(_harmony);

            Jotunn.Logger.LogInfo($"{ModName} {ModVersion} loaded");
        }

        private void OnDestroy()
        {
            _harmony?.UnpatchSelf();
        }

        private void BindConfig()
        {
            // Server-enforced so players can't loosen the rules client-side.
            var adminOnly = new ConfigurationManagerAttributes { IsAdminOnly = true };

            Requirement = Config.Bind("Access", "BaseRequirement", BaseRequirement.Bed,
                new ConfigDescription(
                    "Where the map can be opened. Bed = near your claimed spawn bed (recommended). " +
                    "Workbench = within any workbench's build range. Anywhere = chart only, no location check.",
                    null, adminOnly));

            BaseRadius = Config.Bind("Access", "BedRadius", 20f,
                new ConfigDescription("Meters from your spawn bed that count as 'at base' (Bed mode only).",
                    new AcceptableValueRange<float>(5f, 100f), adminOnly));

            RequireChart = Config.Bind("Access", "RequireChart", true,
                new ConfigDescription("Player must carry a Wayfinder's Chart to open the map.", null, adminOnly));

            AllowMinimap = Config.Bind("Access", "AllowMinimapAtBase", false,
                new ConfigDescription("Show the corner minimap while at base. Off keeps the hardcore feel.", null, adminOnly));

            ChartRecipe = Config.Bind("Chart", "Recipe", "LeatherScraps:4,Resin:4,Coal:2",
                new ConfigDescription(
                    "Crafting cost at a Workbench, as Prefab:Amount pairs. Applied at startup (restart to change).",
                    null, adminOnly));
        }

        private void AddChart()
        {
            PrefabManager.OnVanillaPrefabsAvailable -= AddChart;

            var config = new ItemConfig
            {
                Name = "Wayfinder's Chart",
                Description = "Your hand-inked record of everywhere you've been. " +
                              "Too fragile to unroll in the wilds — study it at home.",
                CraftingStation = CraftingStations.Workbench,
                MinStationLevel = 1,
                Requirements = ParseRecipe(ChartRecipe.Value)
            };

            // LeatherScraps is the closest vanilla look to a rolled parchment.
            var chart = new CustomItem(ChartPrefabName, "LeatherScraps", config);
            var shared = chart.ItemDrop.m_itemData.m_shared;
            shared.m_maxStackSize = 1;
            shared.m_weight = 0.5f;
            shared.m_teleportable = true;
            shared.m_itemType = ItemDrop.ItemData.ItemType.Misc;

            ItemManager.Instance.AddItem(chart);
        }

        private static RequirementConfig[] ParseRecipe(string recipe)
        {
            var result = new System.Collections.Generic.List<RequirementConfig>();
            foreach (var part in recipe.Split(','))
            {
                var pair = part.Split(':');
                if (pair.Length == 2 && int.TryParse(pair[1].Trim(), out int amount) && amount > 0)
                {
                    result.Add(new RequirementConfig(pair[0].Trim(), amount, 0, false));
                }
                else if (part.Trim().Length > 0)
                {
                    Jotunn.Logger.LogWarning($"Ignoring bad recipe entry '{part}' (expected Prefab:Amount)");
                }
            }

            if (result.Count == 0)
            {
                Jotunn.Logger.LogWarning("Chart recipe empty or invalid; falling back to LeatherScraps:4");
                result.Add(new RequirementConfig("LeatherScraps", 4, 0, false));
            }
            return result.ToArray();
        }
    }
}
