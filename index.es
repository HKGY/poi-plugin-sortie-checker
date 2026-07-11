import React, { Component } from 'react'
import { shell } from 'electron'
import { Button, Callout, Card, HTMLSelect, NumericInput, Tag } from '@blueprintjs/core'
import { fleetAirPower, totalLos, los33, airReconScore, transportPoints } from './calc'
import { WORLDS, MAPS } from './mapdata'
import './index.css'

export const windowMode = false

const { getStore } = window

const FLEET_OPTIONS = [
    { value: 'f0', label: '第1舰队' },
    { value: 'f1', label: '第2舰队' },
    { value: 'f2', label: '第3舰队' },
    { value: 'f3', label: '第4舰队' },
    { value: 'combined', label: '联合舰队（第1+第2）' },
    { value: 'strike', label: '游击舰队（第3舰队·7舰）' },
]

// 从 poi store 组装某一舰队的计算输入
const buildFleetRows = (fleetIndex) => {
    const fleet = (getStore('info.fleets') || [])[fleetIndex]
    const ships = getStore('info.ships') || {}
    const equips = getStore('info.equips') || {}
    const $equips = getStore('const.$equips') || {}
    const $ships = getStore('const.$ships') || {}
    if (!fleet || !fleet.api_ship) return []
    const rows = []
    fleet.api_ship.forEach((rosterId) => {
        if (rosterId <= 0) return
        const ship = ships[rosterId]
        if (!ship) return
        const slots = []
        ;(ship.api_slot || []).forEach((equipId, index) => {
            if (equipId <= 0) return
            const item = equips[equipId]
            if (!item) return
            slots.push({
                item,
                $item: $equips[item.api_slotitem_id],
                onslot: (ship.api_onslot || [])[index] || 0,
            })
        })
        if (ship.api_slot_ex > 0) {
            const item = equips[ship.api_slot_ex]
            if (item) slots.push({ item, $item: $equips[item.api_slotitem_id], onslot: 0 })
        }
        rows.push({ ship, $ship: $ships[ship.api_ship_id], slots })
    })
    return rows
}

const getSelection = (fleetKey) => {
    switch (fleetKey) {
        case 'combined':
            return {
                rows: [...buildFleetRows(0), ...buildFleetRows(1)],
                fleetSlots: 12,
            }
        case 'strike':
            return { rows: buildFleetRows(2), fleetSlots: 6 }
        default:
            return { rows: buildFleetRows(Number(fleetKey.slice(1))), fleetSlots: 6 }
    }
}

const fmt = (value, digits = 2) => {
    const factor = 10 ** digits
    return (Math.floor(value * factor) / factor).toFixed(digits)
}

// 制空判定阈值（对敌制空值 enemy）
export const airPowerTiers = enemy => ({
    asPlus: enemy * 3,
    as: Math.ceil(enemy * 1.5),
    parity: Math.ceil(enemy * 2 / 3),
    denial: Math.ceil(enemy / 3),
})

// 单条分歧规则的判定：pass / random（随机带）/ fail；制空规则返回制空等级
const checkRule = (rule, context) => {
    const { rows, fleetSlots, hqLevel } = context
    if (rule.kind === 'airPower') {
        const value = fleetAirPower(rows)
        const enemy = rule.enemy || 0
        const tiers = airPowerTiers(enemy)
        let status = 'loss'
        if (enemy <= 0 || value >= tiers.asPlus) status = 'asPlus'
        else if (value >= tiers.as) status = 'as'
        else if (value >= tiers.parity) status = 'parity'
        else if (value >= tiers.denial) status = 'denial'
        return { value, status }
    }
    let value = null
    if (rule.kind === 'los33') value = los33(rows, hqLevel, rule.cn, fleetSlots)
    else if (rule.kind === 'recon63') value = airReconScore(rows)
    else return { value: null, status: null }
    let status = 'fail'
    if (rule.min == null || value >= rule.min) status = 'pass'
    else if (rule.randomMin != null && value >= rule.randomMin) status = 'random'
    return { value: fmt(value), status }
}

// 出击前状态检查：大破（HP≤25%）与 油弹是否补满
const checkReadiness = (rows) => {
    const taiha = []
    const unsupplied = []
    rows.forEach(({ ship, $ship }) => {
        const name = ($ship && $ship.api_name) || `#${ship.api_id}`
        if (ship.api_maxhp > 0 && ship.api_nowhp / ship.api_maxhp <= 0.25) taiha.push(name)
        if ($ship && (ship.api_fuel < $ship.api_fuel_max || ship.api_bull < $ship.api_bull_max)) {
            unsupplied.push(name)
        }
    })
    return { taiha, unsupplied }
}

const STATUS_DISPLAY = {
    pass: { intent: 'success', label: '满足' },
    random: { intent: 'warning', label: '随机' },
    fail: { intent: 'danger', label: '不足' },
    asPlus: { intent: 'success', label: '确保' },
    as: { intent: 'success', label: '优势' },
    parity: { intent: 'warning', label: '均衡' },
    denial: { intent: 'danger', label: '劣势' },
    loss: { intent: 'danger', label: '丧失' },
}

// 制空规则的说明文字：敌制空值与各档所需制空
const airPowerRuleText = (rule) => {
    const enemy = rule.enemy || 0
    if (enemy <= 0) return `${rule.text}：敌无舰载机（制空 0），必定确保`
    const tiers = airPowerTiers(enemy)
    return `${rule.text}：敌制空 ${enemy} → 均衡 ${tiers.parity} / 优势 ${tiers.as} / 确保 ${tiers.asPlus}`
}

export const reactClass = class SortieChecker extends Component {
    state = {
        fleetKey: 'f0',
        worldId: WORLDS[0].id,
        mapId: MAPS[0].id,
        customCn: 1,
        tick: 0,
    }

    handleWorldChange = (e) => {
        const worldId = Number(e.currentTarget.value)
        const first = MAPS.find(m => m.world === worldId)
        this.setState({ worldId, mapId: first ? first.id : this.state.mapId })
    }

    componentDidMount() {
        window.addEventListener('game.response', this.handleGameResponse)
    }

    componentWillUnmount() {
        window.removeEventListener('game.response', this.handleGameResponse)
        clearTimeout(this.refreshTimer)
    }

    // 编成/装备变化都会伴随 API 响应，节流后刷新即可
    handleGameResponse = () => {
        clearTimeout(this.refreshTimer)
        this.refreshTimer = setTimeout(
            () => this.setState(({ tick }) => ({ tick: tick + 1 })),
            500,
        )
    }

    refresh = () => this.setState(({ tick }) => ({ tick: tick + 1 }))

    renderReadiness(rows) {
        const { taiha, unsupplied } = checkReadiness(rows)
        if (!taiha.length && !unsupplied.length) {
            return (
                <Callout intent="success" className="readiness-callout">
                    出击检查通过：无大破舰船，油弹全满。
                </Callout>
            )
        }
        return (
            <div className="readiness-group">
                {taiha.length > 0 && (
                    <Callout intent="danger" className="readiness-callout">
                        大破舰船（出击有轰沉风险！）：{taiha.join('、')}
                    </Callout>
                )}
                {unsupplied.length > 0 && (
                    <Callout intent="warning" className="readiness-callout">
                        油弹未满：{unsupplied.join('、')}
                    </Callout>
                )}
            </div>
        )
    }

    // 活动图简化展示：贴条 / 攻略步骤 / 路线+推荐阵容（舰种）
    renderEventInfo(map) {
        return (
            <React.Fragment>
                {(map.tags || []).length > 0 && (
                    <div className="rule-section">
                        <h4>贴条（札）</h4>
                        {map.tags.map((text, index) => (
                            <div className="special-row" key={index}>· {text}</div>
                        ))}
                    </div>
                )}
                {(map.steps || []).length > 0 && (
                    <div className="rule-section">
                        <h4>攻略步骤</h4>
                        {map.steps.map((text, index) => (
                            <div className="special-row" key={index}>{index + 1}. {text}</div>
                        ))}
                    </div>
                )}
                {(map.phases || []).length > 0 && (
                    <div className="rule-section">
                        <h4>路线 / 推荐阵容（舰种）</h4>
                        {map.phases.map((phase, index) => (
                            <div className="phase-block" key={index}>
                                <div className="phase-head">
                                    <Tag minimal intent="primary" className="rule-tag">{phase.title}</Tag>
                                    <Tag minimal className="phase-tag">札：{phase.tag}</Tag>
                                </div>
                                <div className="phase-body">
                                    <div className="phase-comp"><b>{phase.comp}</b></div>
                                    <div className="phase-route">路线：{phase.route}</div>
                                    {phase.note && <div className="phase-note">※ {phase.note}</div>}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
                <div className="map-note event-footnote">
                    ※ 攻略参考自{' '}
                    <a
                        href="https://github.com/HKGY/2026SummerEvent"
                        onClick={(e) => {
                            e.preventDefault()
                            shell.openExternal('https://github.com/HKGY/2026SummerEvent')
                        }}
                    >
                        HKGY/2026SummerEvent
                    </a>{' '}
                    仓库的实战记录，仅供参考——请结合自身练度、装备与检证情报调整编成，对照抄导致的卡关概不负责。
                </div>
            </React.Fragment>
        )
    }

    renderRuleSection(title, rules, context, hint) {
        if (!rules.length) return null
        return (
            <div className="rule-section">
                <h4>{title}</h4>
                {hint && <div className="map-note">{hint}</div>}
                {rules.map((rule, index) => {
                    const { value, status } = checkRule(rule, context)
                    const display = STATUS_DISPLAY[status]
                    return (
                        <div className="rule-row" key={index}>
                            {display ? (
                                <Tag intent={display.intent} className="rule-tag">
                                    {display.label} {value}
                                </Tag>
                            ) : (
                                <Tag minimal className="rule-tag">参考</Tag>
                            )}
                            <span className="rule-text">
                                {rule.node ? `[${rule.node}] ` : ''}
                                {rule.kind === 'airPower' ? airPowerRuleText(rule) : rule.text}
                            </span>
                        </div>
                    )
                })}
            </div>
        )
    }

    render() {
        const { fleetKey, worldId, mapId, customCn } = this.state
        const hqLevel = getStore('info.basic.api_level') || 120
        const { rows, fleetSlots } = getSelection(fleetKey)
        const map = MAPS.find(m => m.id === mapId) || MAPS[0]
        const context = { rows, fleetSlots, hqLevel }

        const airPower = fleetAirPower(rows)
        const losTotal = totalLos(rows)
        const recon = airReconScore(rows)
        const tp = transportPoints(rows)

        return (
            <div id="sortie-checker" className="sortie-checker">
                <div className="control-row">
                    <HTMLSelect
                        value={fleetKey}
                        options={FLEET_OPTIONS}
                        onChange={e => this.setState({ fleetKey: e.currentTarget.value })}
                    />
                    <HTMLSelect
                        value={worldId}
                        options={WORLDS.map(w => ({ value: w.id, label: `${w.id} ${w.name}` }))}
                        onChange={this.handleWorldChange}
                    />
                    <HTMLSelect
                        value={mapId}
                        options={MAPS.filter(m => m.world === worldId)
                            .map(m => ({ value: m.id, label: `${m.id} ${m.name}` }))}
                        onChange={e => this.setState({ mapId: e.currentTarget.value })}
                    />
                    <Button small icon="refresh" onClick={this.refresh}>刷新</Button>
                </div>

                {!rows.length && (
                    <Callout intent="warning">所选舰队为空，请先编成。</Callout>
                )}

                {rows.length > 0 && this.renderReadiness(rows)}

                <div className="stat-grid">
                    <Card className="stat-card">
                        <div className="stat-label">制空值</div>
                        <div className="stat-value">{airPower}</div>
                        <div className="stat-sub">熟练度按保底计算</div>
                    </Card>
                    <Card className="stat-card">
                        <div className="stat-label">索敌合计</div>
                        <div className="stat-value">{losTotal}</div>
                        <div className="stat-sub">面板显示值之和</div>
                    </Card>
                    <Card className="stat-card">
                        <div className="stat-label">输送 TP</div>
                        <div className="stat-value">
                            {tp.s}
                            <span className="tp-a"> / A胜 {tp.a}</span>
                        </div>
                        <div className="stat-sub">S胜 / A胜=×0.7 取整；大破·退避舰实战不计</div>
                    </Card>
                    <Card className="stat-card">
                        <div className="stat-label">6-3 航空侦察</div>
                        <div className="stat-value">{fmt(recon)}</div>
                        <div className="stat-sub">水侦/水爆×⁴√搭载 + 大艇×√搭载</div>
                    </Card>
                    <Card className="stat-card">
                        <div className="stat-label">
                            33式（司令部 Lv.{hqLevel}
                            {fleetSlots === 12 ? '·联合' : rows.length === 7 ? '·7舰' : ''}）
                        </div>
                        <div className="los33-row">
                            {[1, 2, 3, 4].map(cn => (
                                <span key={cn} className="los33-item">
                                    <span className="los33-cn">×{cn}</span>
                                    {fmt(los33(rows, hqLevel, cn, fleetSlots))}
                                </span>
                            ))}
                            <span className="los33-item los33-custom">
                                <NumericInput
                                    value={customCn}
                                    min={0}
                                    stepSize={0.5}
                                    onValueChange={value => Number.isFinite(value)
                                        && this.setState({ customCn: value })}
                                />
                                <span>{fmt(los33(rows, hqLevel, customCn, fleetSlots))}</span>
                            </span>
                        </div>
                    </Card>
                </div>

                <Card className="rules-card">
                    <h3>{map.id} {map.name}</h3>
                    {map.event ? this.renderEventInfo(map) : this.renderNormalInfo(map, context)}
                </Card>
            </div>
        )
    }

    renderNormalInfo(map, context) {
        return (
            <React.Fragment>
                    {this.renderRuleSection('索敌 / 航空侦察要求',
                        map.rules.filter(rule => rule.kind === 'los33' || rule.kind === 'recon63'),
                        context, '※ 33式阈值以司令部 Lv120 为基准，等级较低时建议多留余量。')}
                    {this.renderRuleSection('制空要求',
                        map.rules.filter(rule => rule.kind === 'airPower'), context)}
                    {!map.rules.length && (
                        <Callout>该海域没有已知的索敌/制空/航空侦察定量条件。</Callout>
                    )}
                    {(map.special || []).length > 0 && (
                        <div className="rule-section">
                            <h4>特殊分歧条件</h4>
                            {map.special.map((text, index) => (
                                <div className="special-row" key={index}>· {text}</div>
                            ))}
                        </div>
                    )}
                    {(map.fleets || []).length > 0 && (
                        <div className="rule-section">
                            <h4>推荐阵容</h4>
                            {map.fleets.map((fleet, index) => (
                                <div className="fleet-row" key={index}>
                                    <Tag minimal intent="primary" className="rule-tag">{fleet.title}</Tag>
                                    <span className="fleet-text">
                                        <b>{fleet.comp}</b>
                                        {fleet.route ? <span className="fleet-route">（{fleet.route}）</span> : null}
                                        {fleet.note ? <span className="fleet-note"> — {fleet.note}</span> : null}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                    {map.notes && map.notes.map((note, index) => (
                        <div className="map-note" key={index}>※ {note}</div>
                    ))}
            </React.Fragment>
        )
    }
}
