/*
 * 纯计算模块：制空值 / 索敌合计 / 33式 / 6-3 航空侦察分数
 *
 * 输入统一为 shipRow 列表，由 index.es 从 poi store 组装：
 *   shipRow = {
 *     ship,                     // info.ships 中的舰娘实例（api_sakuteki 等）
 *     slots: [{ item, $item, onslot }],  // item: 装备实例(api_level/api_alv)
 *   }                                    // $item: 装备 master(api_type/api_saku/api_tyku)
 */

// ---------- 装备类别（api_type[2]） ----------
export const T2 = {
    DIVE_BOMBER: 7, // 舰上爆击机
    TORPEDO_BOMBER: 8, // 舰上攻击机
    CARRIER_RECON: 9, // 舰上侦察机
    SEAPLANE_RECON: 10, // 水上侦察机
    SEAPLANE_BOMBER: 11, // 水上爆击机
    SMALL_RADAR: 12, // 小型电探
    LARGE_RADAR: 13, // 大型电探
    AUTOGYRO: 25, // 回转翼机
    ASW_PLANE: 26, // 对潜哨戒机
    LARGE_FLYING_BOAT: 41, // 大型飞行艇
    FIGHTER: 45, // 水上战斗机
    CARRIER_FIGHTER: 6, // 舰上战斗机
    JET_FIGHTER: 56, // 喷式战斗机
    JET_FIGHTER_BOMBER: 57, // 喷式战斗爆击机
    JET_TORPEDO_BOMBER: 58, // 喷式攻击机
}

// ---------- 制空值 ----------

// 参与舰队制空的机种
const AIR_POWER_TYPES = new Set([
    T2.CARRIER_FIGHTER, T2.DIVE_BOMBER, T2.TORPEDO_BOMBER,
    T2.SEAPLANE_BOMBER, T2.FIGHTER,
    T2.JET_FIGHTER, T2.JET_FIGHTER_BOMBER, T2.JET_TORPEDO_BOMBER,
])

// 熟练度等级 -> 内部经验下限（取保底值）
const INTERNAL_EXP = [0, 10, 25, 40, 55, 70, 85, 100]
// 舰战/水战/喷式战 的熟练度制空加成
const PROF_BONUS_FIGHTER = [0, 0, 2, 5, 9, 14, 14, 22]
// 水爆 的熟练度制空加成
const PROF_BONUS_SPB = [0, 0, 1, 1, 1, 3, 3, 6]

const isFighterLike = t2 =>
    t2 === T2.CARRIER_FIGHTER || t2 === T2.FIGHTER || t2 === T2.JET_FIGHTER

// 爆战（战斗爆击机）：改修按 +0.25×★ 计对空
const isFighterBomber = ($item) => {
    const name = ($item && $item.api_name) || ''
    return /爆戦|岩井/.test(name)
}

// 单格制空值（保底熟练度）
export const slotAirPower = (item, $item, onslot) => {
    if (!$item || !onslot || onslot <= 0) return 0
    const t2 = $item.api_type[2]
    if (!AIR_POWER_TYPES.has(t2)) return 0
    const stars = (item && item.api_level) || 0
    const alv = Math.min((item && item.api_alv) || 0, 7)
    let aa = $item.api_tyku || 0
    if (isFighterLike(t2)) aa += 0.2 * stars
    else if (t2 === T2.DIVE_BOMBER && isFighterBomber($item)) aa += 0.25 * stars
    let bonus = Math.sqrt(INTERNAL_EXP[alv] / 10)
    if (isFighterLike(t2)) bonus += PROF_BONUS_FIGHTER[alv]
    else if (t2 === T2.SEAPLANE_BOMBER) bonus += PROF_BONUS_SPB[alv]
    return Math.floor(aa * Math.sqrt(onslot) + bonus)
}

export const fleetAirPower = shipRows =>
    shipRows.reduce((total, row) =>
        total + row.slots.reduce((sum, { item, $item, onslot }) =>
            sum + slotAirPower(item, $item, onslot), 0), 0)

// ---------- 索敌 ----------

// 33式装备系数
const los33Multiplier = (t2) => {
    switch (t2) {
        case T2.DIVE_BOMBER: return 0.6
        case T2.TORPEDO_BOMBER: return 0.8
        case T2.CARRIER_RECON: return 1.0
        case T2.SEAPLANE_RECON: return 1.2
        case T2.SEAPLANE_BOMBER: return 1.1
        default: return 0.6
    }
}

// 33式改修系数（每 √★）
const los33ImproveCoef = (t2) => {
    switch (t2) {
        case T2.CARRIER_RECON: return 1.2
        case T2.SEAPLANE_RECON: return 1.2
        case T2.SEAPLANE_BOMBER: return 1.15
        case T2.SMALL_RADAR: return 1.25
        case T2.LARGE_RADAR: return 1.4
        case T2.LARGE_FLYING_BOAT: return 1.2
        case T2.ASW_PLANE: return 1.0
        default: return 0
    }
}

// 表示用的索敌合计（面板显示值之和）
export const totalLos = shipRows =>
    shipRows.reduce((sum, { ship }) =>
        sum + ((ship.api_sakuteki && ship.api_sakuteki[0]) || 0), 0)

/*
 * 33式：Cn × Σ装备项 + Σ√素索敌 − ⌈0.4×司令部等级⌉ + 2×(空位数)
 * fleetSlots: 单舰队 6 / 联合舰队 12
 */
export const los33 = (shipRows, hqLevel, cn, fleetSlots = 6) => {
    let equipTerm = 0
    let shipTerm = 0
    shipRows.forEach(({ ship, slots }) => {
        let equipLos = 0
        slots.forEach(({ item, $item }) => {
            if (!$item) return
            const saku = $item.api_saku || 0
            equipLos += saku
            const t2 = $item.api_type[2]
            const stars = (item && item.api_level) || 0
            equipTerm += los33Multiplier(t2) * (saku + los33ImproveCoef(t2) * Math.sqrt(stars))
        })
        const pureLos = Math.max(((ship.api_sakuteki && ship.api_sakuteki[0]) || 0) - equipLos, 0)
        shipTerm += Math.sqrt(pureLos)
    })
    return cn * equipTerm + shipTerm
        - Math.ceil(0.4 * hqLevel)
        + 2 * (fleetSlots - shipRows.length)
}

// ---------- 输送作战 TP ----------

// 舰种 TP（api_stype），未列出的舰种为 0
const TP_BY_STYPE = {
    2: 5, // 駆逐艦
    3: 2, // 軽巡洋艦
    6: 4, // 航空巡洋艦
    10: 7, // 航空戦艦
    16: 9, // 水上機母艦
    17: 12, // 揚陸艦
    20: 7, // 潜水母艦
    21: 6, // 練習巡洋艦
    22: 15, // 補給艦
}

// 装备 TP（api_type[2]）
const TP_BY_T2 = {
    24: 8, // 上陸用舟艇（大発系）
    46: 2, // 特型内火艇
    30: 5, // 簡易輸送部材（ドラム缶）
    43: 1, // 戦闘糧食
}

// 大発分类中不计 TP 的例外：装甲艇(AB艇)、武装大発
const TP_EXCLUDED_ITEMS = new Set([408, 409])

/*
 * 输送 TP：S 胜取整数合计，A 胜 = ⌊S × 0.7⌋
 * 实战中大破/退避舰不计入，此处按出击前全员计算。
 */
export const transportPoints = (shipRows) => {
    let total = 0
    shipRows.forEach(({ ship, $ship, slots }) => {
        total += TP_BY_STYPE[($ship && $ship.api_stype) || 0] || 0
        if (ship.api_ship_id === 487) total += 8 // 鬼怒改二
        slots.forEach(({ $item }) => {
            if (!$item || TP_EXCLUDED_ITEMS.has($item.api_id)) return
            total += TP_BY_T2[$item.api_type[2]] || 0
        })
    })
    return { s: total, a: Math.floor(total * 0.7) }
}

// ---------- 6-3 航空侦察 ----------

/*
 * 航空侦察分数（wikiwiki 6-3）：
 *   水上侦察机 / 水上爆击机: 索敌值 × 搭载数^0.25
 *   大型飞行艇:             索敌值 × 搭载数^0.5
 * 搭载数按侦察点到达时残机数计，此处用当前搭载数（未计道中击坠）。
 */
export const airReconScore = shipRows =>
    shipRows.reduce((total, row) =>
        total + row.slots.reduce((sum, { $item, onslot }) => {
            if (!$item || !onslot || onslot <= 0) return sum
            const t2 = $item.api_type[2]
            const saku = $item.api_saku || 0
            if (t2 === T2.SEAPLANE_RECON || t2 === T2.SEAPLANE_BOMBER) {
                return sum + saku * Math.sqrt(Math.sqrt(onslot))
            }
            if (t2 === T2.LARGE_FLYING_BOAT) {
                return sum + saku * Math.sqrt(onslot)
            }
            return sum
        }, 0), 0)
