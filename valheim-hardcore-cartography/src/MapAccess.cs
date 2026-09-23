using UnityEngine;

namespace HardcoreCartography
{
    /// <summary>Rules for when a player in a no-map world may look at the map.</summary>
    internal static class MapAccess
    {
        private const string WorkbenchName = "$piece_workbench";

        public static bool CanOpen(Player player, out string reason)
        {
            if (Plugin.RequireChart.Value && !HasChart(player))
            {
                reason = "You need a Wayfinder's Chart to read the map";
                return false;
            }

            return IsAtBase(player, out reason);
        }

        public static bool HasChart(Player player)
        {
            foreach (var item in player.GetInventory().GetAllItems())
            {
                if (item.m_dropPrefab && item.m_dropPrefab.name == Plugin.ChartPrefabName)
                {
                    return true;
                }
            }
            return false;
        }

        private static bool IsAtBase(Player player, out string reason)
        {
            reason = null;
            var position = player.transform.position;

            switch (Plugin.Requirement.Value)
            {
                case BaseRequirement.Anywhere:
                    return true;

                case BaseRequirement.Workbench:
                    if (CraftingStation.HaveBuildStationInRange(WorkbenchName, position))
                    {
                        return true;
                    }
                    reason = "Your chart can only be studied near a workbench";
                    return false;

                default:
                    var profile = Game.instance ? Game.instance.GetPlayerProfile() : null;
                    if (profile == null || !profile.HaveCustomSpawnPoint())
                    {
                        reason = "Claim a bed first - your chart can only be studied at home";
                        return false;
                    }

                    var bed = profile.GetCustomSpawnPoint();
                    var flat = new Vector2(bed.x - position.x, bed.z - position.z);
                    if (flat.magnitude <= Plugin.BaseRadius.Value)
                    {
                        return true;
                    }
                    reason = "Your chart can only be studied at home, near your bed";
                    return false;
            }
        }
    }
}
