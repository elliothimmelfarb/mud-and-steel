/**
 * Upgrade-derived modifiers, recomputed whenever the player buys something.
 * Sim systems read these instead of poking through the upgrade set.
 */
export class Mods {
  rifleDmg = 1
  grenDmg = 1
  grenAoe = 0
  gasResistMasked = 0.3      // damage multiplier while masked (PH helmets etc lower it)
  autoMasks = false
  maskAccPenalty = 0.82
  bounty = 1
  healRate = 1
  heatRate = 1
  sniperRange = 0
  sniperCrit = 0
  reconIntel = false
  indirectScatter = 1
  barrageCasualty = 1         // multiplier on barrage damage while taking cover
  waveIncome = 0
  creepUnlocked = false
  tankUnlocked = false
  costMult = 1
  parapetMult = 1
  repairRate = 1
  moraleFloor = 0
  rallyRate = 1
  hospitalReturn = 0
  counterBattery = 1          // multiplier on enemy barrage shell count
  emplacementHp = 1

  recompute(upgrades: ReadonlySet<string>): void {
    const has = (id: string) => upgrades.has(id)
    this.rifleDmg = has('smle') ? 1.15 : 1
    this.grenDmg = has('mills') ? 1.25 : 1
    this.grenAoe = has('mills') ? 1 : 0
    this.gasResistMasked = has('boxrespirator') ? 0.04 : has('maskph') ? 0.3 : 0.55
    this.autoMasks = has('maskph')
    this.maskAccPenalty = has('boxrespirator') ? 0.91 : 0.82
    this.bounty = has('salvage') ? 1.25 : 1
    this.healRate = has('dressings') ? 1.5 : 1
    this.heatRate = has('mgdiscipline') ? 0.6 : 1
    this.sniperRange = has('scopes') ? 20 : 0
    this.sniperCrit = has('scopes') ? 0.15 : 0
    this.reconIntel = has('recon')
    this.indirectScatter = has('recon') ? 0.8 : 1
    this.barrageCasualty = has('dugouts') ? 0.5 : 1
    this.waveIncome = has('depot') ? 40 : 0
    this.creepUnlocked = has('creepingdoctrine')
    this.tankUnlocked = has('markiv')
    this.costMult = has('quartermaster') ? 0.9 : 1
    this.parapetMult = (has('spades') ? 1.4 : 1) * (has('concrete') ? 1.6 : 1)
    this.repairRate = has('spades') ? 1.5 : 1
    this.moraleFloor = has('rum') ? 0.18 : 0
    this.rallyRate = has('rum') ? 2 : 1
    this.hospitalReturn = has('hospital') ? 0.3 : 0
    this.counterBattery = has('counterbattery') ? 0.6 : 1
    this.emplacementHp = has('concrete') ? 1.6 : 1
  }
}
