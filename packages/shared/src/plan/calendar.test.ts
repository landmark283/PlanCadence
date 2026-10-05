/**
 * 月历运算的测试。
 *
 * 这一组盯的是那些**看起来显然、其实每年都会错一次**的地方：
 * 周起始日、月末夹逼、跨年、闰年。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MONTH_GRID_DAYS,
  addMonths,
  daysInMonth,
  inMonth,
  monthGridDays,
  monthLabel,
  monthOf,
  startOfWeek,
  weekDays,
} from './calendar.ts';

describe('月份的表示', () => {
  it('monthOf 取到年月', () => {
    assert.equal(monthOf('2026-10-19'), '2026-10');
    assert.equal(monthOf('2026-01-01'), '2026-01');
  });

  it('monthLabel 不带前导零——中文里「2026 年 10 月」比「2026 年 01 月」自然', () => {
    assert.equal(monthLabel('2026-10-19'), '2026 年 10 月');
    assert.equal(monthLabel('2027-01-03'), '2027 年 1 月');
  });

  it('inMonth 按月判断', () => {
    assert.equal(inMonth('2026-10-01', '2026-10'), true);
    assert.equal(inMonth('2026-10-31', '2026-10'), true);
    assert.equal(inMonth('2026-09-30', '2026-10'), false);
    assert.equal(inMonth('2026-10-01', '2026-1'), false, "不能把 '2026-1' 当成 '2026-01'");
  });
});

describe('每月天数', () => {
  it('普通月份', () => {
    assert.equal(daysInMonth(2026, 1), 31);
    assert.equal(daysInMonth(2026, 4), 30);
    assert.equal(daysInMonth(2026, 11), 30);
  });

  it('2 月：平年 28、闰年 29', () => {
    assert.equal(daysInMonth(2026, 2), 28);
    assert.equal(daysInMonth(2028, 2), 29);
    // 世纪闰年规则：2000 是闰年，1900 不是
    assert.equal(daysInMonth(2000, 2), 29);
    assert.equal(daysInMonth(1900, 2), 28);
  });

  it('12 月不会溢出到下一年', () => {
    assert.equal(daysInMonth(2026, 12), 31);
  });
});

describe('加减月份', () => {
  it('普通前进后退', () => {
    assert.equal(addMonths('2026-10-19', 1), '2026-11-19');
    assert.equal(addMonths('2026-10-19', -1), '2026-09-19');
    assert.equal(addMonths('2026-10-19', 3), '2027-01-19');
  });

  it('跨年，两个方向都要对', () => {
    assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
    assert.equal(addMonths('2026-01-15', -1), '2025-12-15');
  });

  it('n = 0 是原样返回', () => {
    assert.equal(addMonths('2026-10-19', 0), '2026-10-19');
  });

  it('日期夹到月末，而不是溢出到下下个月', () => {
    // 这一步不能省：Date.UTC(2026, 1, 31) 会变成 3 月 3 日
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
    assert.equal(addMonths('2028-01-31', 1), '2028-02-29', '闰年要夹到 29');
    assert.equal(addMonths('2026-08-31', 1), '2026-09-30');
  });

  it('加一个月再减一个月不一定回到原点（夹逼的必然结果）', () => {
    // 写下来是为了说明这是**已知且正确**的行为，不是 bug
    assert.equal(addMonths(addMonths('2026-01-31', 1), -1), '2026-01-28');
  });

  it('连续跨多个年', () => {
    assert.equal(addMonths('2026-10-19', 14), '2027-12-19');
    assert.equal(addMonths('2026-10-19', -14), '2025-08-19');
  });
});

describe('周起始日', () => {
  it('周一为一周之首', () => {
    // 2026-10-19 是周一
    assert.equal(startOfWeek('2026-10-19'), '2026-10-19');
    assert.equal(startOfWeek('2026-10-22'), '2026-10-19', '周四落在同一个周一');
    // 2026-10-25 是周日——它属于 10-19 那一周，不是下一周
    assert.equal(startOfWeek('2026-10-25'), '2026-10-19');
    // 2026-10-26 是下周一
    assert.equal(startOfWeek('2026-10-26'), '2026-10-26');
  });

  it('weekDays 是周一起的 7 天', () => {
    const days = weekDays('2026-10-19');
    assert.equal(days.length, 7);
    assert.equal(days[0], '2026-10-19');
    assert.equal(days[6], '2026-10-25');
  });

  it('跨月的那一周', () => {
    assert.equal(startOfWeek('2026-11-01'), '2026-10-26', '11 月 1 日是周日');
  });
});

describe('月历网格', () => {
  it('固定 42 天', () => {
    assert.equal(monthGridDays('2026-10-19').length, MONTH_GRID_DAYS);
    assert.equal(monthGridDays('2026-02-01').length, MONTH_GRID_DAYS);
  });

  it('第一天是周一，最后一天是周日', () => {
    for (const anchor of ['2026-10-19', '2026-02-15', '2027-01-01', '2028-02-29']) {
      const grid = monthGridDays(anchor);
      assert.equal(startOfWeek(grid[0]!), grid[0], `${anchor} 的补格第一天应该是周一`);
      assert.equal(startOfWeek(grid[41]!), grid[35], `${anchor} 的最后一行应该同属一周`);
    }
  });

  it('包含本月全部日子', () => {
    const grid = monthGridDays('2026-10-19');
    for (let d = 1; d <= 31; d++) {
      const day = `2026-10-${String(d).padStart(2, '0')}`;
      assert.ok(grid.includes(day), `${day} 应该出现在 10 月的网格里`);
    }
  });

  it('补格确实跨到了前后两个月', () => {
    // 2026-10-01 是周四，所以 9 月的 28/29/30 会补在开头
    const grid = monthGridDays('2026-10-19');
    assert.equal(grid[0], '2026-09-28');
    assert.equal(grid[41], '2026-11-08');
    assert.equal(grid.filter((d) => inMonth(d, '2026-09')).length, 3);
    assert.equal(grid.filter((d) => inMonth(d, '2026-11')).length, 8);
  });

  it('2 月的网格不会漏掉闰日', () => {
    const grid = monthGridDays('2028-02-10');
    assert.ok(grid.includes('2028-02-29'));
    assert.ok(!grid.includes('2028-02-30'));
  });

  it('跨年：12 月的网格里有次年 1 月', () => {
    const grid = monthGridDays('2026-12-15');
    assert.ok(grid.some((d) => inMonth(d, '2027-01')));
  });

  it('连续三天不重复、不乱序', () => {
    const grid = monthGridDays('2026-10-19');
    assert.equal(new Set(grid).size, MONTH_GRID_DAYS, '不能有重复的日子');
    const sorted = [...grid].sort();
    assert.deepEqual(grid, sorted, '必须是严格递增的');
  });
});
