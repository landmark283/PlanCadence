/**
 * 访谈控件 —— 把 `QuestionSpec` 的每种 kind 渲染成对应表单控件。
 *
 * 这是「不做聊天框」这个决定的落点：模型只决定**问什么**，
 * 怎么渲染、怎么校验、触控区多大，全部由这里说了算。
 * 所以模型再离谱也只会问出怪问题，不会做出没法用的界面。
 *
 * 草稿状态由父组件持有（`Draft`），控件本身是无状态的。
 * 这样「上一题」回去改答案时，把草稿重新初始化即可，不用让控件各自维护历史。
 */
import { Pressable, StyleSheet, View } from 'react-native';
import type { Answer, QuestionSpec } from '@sp/shared';

import { AppText } from '@/components/app-text';
import { Chip } from '@/components/chip';
import { Input as InputBase, type InputProps } from '@/components/input';
import { addDays, daysBetween, fmtMonthDay } from '@/lib/dates';
import { radius, space, useTokens } from '@/theme';

export type Draft = {
  single: string | null;
  multi: string[];
  scale: number | null;
  date: string;
  /** dateRange 用 */
  rangeFrom: string;
  rangeTo: string;
  reason: string | null;
  text: string;
};

export const emptyDraft = (): Draft => ({
  single: null,
  multi: [],
  scale: null,
  date: '',
  rangeFrom: '',
  rangeTo: '',
  reason: null,
  text: '',
});

/** 回到上一题时，把已有作答还原成草稿 */
export function initDraft(q: QuestionSpec, a: Answer | undefined): Draft {
  const d = emptyDraft();
  if (!a) {
    // scale 题给个中间值做起点，省得学生先拖一下才看到反馈
    if (q.kind === 'scale' && q.min !== null && q.max !== null) {
      d.scale = Math.round((q.min + q.max) / 2);
    }
    return d;
  }
  switch (a.kind) {
    case 'single':
      d.single = a.value;
      break;
    case 'multi':
      d.multi = a.values;
      break;
    case 'scale':
      d.scale = a.value;
      break;
    case 'date':
      d.date = a.value ?? '';
      break;
    case 'dateRange':
      d.rangeFrom = a.from;
      d.rangeTo = a.to;
      d.reason = a.reason;
      break;
    case 'text':
      d.text = a.value;
      break;
  }
  return d;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function draftToAnswer(q: QuestionSpec, d: Draft): Answer {
  switch (q.kind) {
    case 'single':
      return { questionId: q.id, kind: 'single', value: d.single ?? '' };
    case 'multi':
      return { questionId: q.id, kind: 'multi', values: d.multi };
    case 'scale':
      return { questionId: q.id, kind: 'scale', value: d.scale ?? q.min ?? 0 };
    case 'date':
      return { questionId: q.id, kind: 'date', value: DATE_RE.test(d.date) ? d.date : null };
    case 'dateRange':
      // 两端都合法才算答了；半截输入一律原样带上去，由 applyAnswer 判为未答
      return { questionId: q.id, kind: 'dateRange', from: d.rangeFrom, to: d.rangeTo, reason: d.reason };
    case 'text':
      return { questionId: q.id, kind: 'text', value: d.text.trim() };
  }
}

/** 这一题是否等于没答。用来决定「继续」的文案与跳过提示 */
export function isDraftEmpty(q: QuestionSpec, d: Draft): boolean {
  switch (q.kind) {
    case 'single':
      return d.single === null;
    case 'multi':
      return d.multi.length === 0;
    case 'scale':
      return d.scale === null;
    case 'date':
      return !DATE_RE.test(d.date);
    case 'dateRange':
      return !DATE_RE.test(d.rangeFrom) || !DATE_RE.test(d.rangeTo) || d.rangeTo < d.rangeFrom;
    case 'text':
      return d.text.trim().length === 0;
  }
}

/**
 * 同上，但针对已经转好的 `Answer`。
 *
 * 为什么需要两个：草稿活在父组件的会话状态里，
 * 而底部按钮的文案也活在父组件里。前者是编辑中的值，后者是已提交的值，
 * 两者在「点继续之前」并不相同，分开判断才不会互相污染。
 */
export function isAnswerEmpty(q: QuestionSpec, a: Answer | undefined): boolean {
  if (!a) return true;
  switch (a.kind) {
    case 'single':
      return a.value === '';
    case 'multi':
      return a.values.length === 0;
    case 'scale':
      return false;
    case 'date':
      return a.value === null;
    case 'dateRange':
      return !DATE_RE.test(a.from) || !DATE_RE.test(a.to) || a.to < a.from;
    case 'text':
      return a.value.trim().length === 0;
  }
}

/** scale 题的档位。区间太大时自动收成不超过 6 档，避免一屏全是按钮 */
function scaleStops(q: QuestionSpec): number[] {
  const min = q.min ?? 0;
  const max = q.max ?? 10;
  const raw = q.step ?? 1;
  const span = max - min;
  const step = Math.max(raw, Math.ceil(span / 6 / raw) * raw);
  const out: number[] = [];
  for (let v = min; v <= max; v += step) out.push(v);
  if (out[out.length - 1] !== max) out.push(max);
  return out;
}

const DATE_PRESETS: { label: string; days: number }[] = [
  { label: '1 个月后', days: 30 },
  { label: '3 个月后', days: 90 },
  { label: '半年后', days: 182 },
  { label: '一年后', days: 365 },
];

/** 不可用区间的原因。写成可选胶囊而不是输入框：它会显示在计划里，越短越好读 */
const BLACKOUT_REASONS = ['期中考试周', '期末考试周', '寒暑假', '要回家'];

export type QuestionControlProps = {
  question: QuestionSpec;
  draft: Draft;
  onChange: (next: Draft) => void;
  /** 基准日，用于把「半年后」这类预设换算成具体日期 */
  today: string;
};

export function QuestionControl({ question, draft, onChange, today }: QuestionControlProps) {
  return (
    // testID 让端到端流程脚本能把查询范围限定在控件内，
    // 否则底部操作栏的按钮也会被 `[role="button"]` 命中
    <View testID="question-control">
      <ControlBody question={question} draft={draft} onChange={onChange} today={today} />
    </View>
  );
}

function ControlBody({ question: q, draft, onChange, today }: QuestionControlProps) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });

  switch (q.kind) {
    case 'single':
      return (
        <View style={styles.col}>
          {q.options.map((o) => (
            <OptionRow
              key={o.value}
              label={o.label}
              selected={draft.single === o.value}
              onPress={() => set({ single: o.value })}
            />
          ))}
        </View>
      );

    case 'multi': {
      const toggle = (v: string) =>
        set({ multi: draft.multi.includes(v) ? draft.multi.filter((x) => x !== v) : [...draft.multi, v] });
      return (
        <View style={styles.col}>
          {q.options.map((o) => (
            <OptionRow
              key={o.value}
              label={o.label}
              selected={draft.multi.includes(o.value)}
              multiple
              onPress={() => toggle(o.value)}
            />
          ))}
        </View>
      );
    }

    case 'scale':
      return (
        <View style={styles.col}>
          <View style={styles.wrap}>
            {scaleStops(q).map((v) => (
              <Chip
                key={v}
                tone="neutral"
                selected={draft.scale === v}
                accessibilityLabel={`${v} ${q.unit ?? ''}`}
                onPress={() => set({ scale: v })}
              >
                {v}
              </Chip>
            ))}
          </View>
          <AppText variant="label" tone="textMuted">
            {draft.scale !== null ? `${draft.scale} ${q.unit ?? ''}` : `选一个大概的值${q.unit ? `（${q.unit}）` : ''}`}
          </AppText>
        </View>
      );

    case 'date': {
      const bad = draft.date.length > 0 && !DATE_RE.test(draft.date);
      return (
        <View style={styles.col}>
          <View style={styles.wrap}>
            {DATE_PRESETS.map((p) => {
              const value = addDays(today, p.days);
              return (
                <Chip
                  key={p.label}
                  tone="neutral"
                  selected={draft.date === value}
                  accessibilityLabel={`${p.label}，即 ${value}`}
                  onPress={() => set({ date: value })}
                >
                  {p.label}
                </Chip>
              );
            })}
          </View>
          <Input
            value={draft.date}
            placeholder={q.placeholder ?? 'YYYY-MM-DD'}
            onChangeText={(v) => set({ date: v.trim() })}
            keyboardType="numbers-and-punctuation"
          />
          <AppText variant="caption" tone={bad ? 'danger' : 'textFaint'}>
            {bad
              ? '日期格式要是 2027-04-11 这样'
              : draft.date && DATE_RE.test(draft.date)
                ? `即 ${fmtMonthDay(draft.date)}`
                : '不填也可以，但那样只能按每周固定量推进，没法倒排。'}
          </AppText>
        </View>
      );
    }

    case 'dateRange': {
      const badFrom = draft.rangeFrom.length > 0 && !DATE_RE.test(draft.rangeFrom);
      const badTo = draft.rangeTo.length > 0 && !DATE_RE.test(draft.rangeTo);
      const inverted =
        DATE_RE.test(draft.rangeFrom) && DATE_RE.test(draft.rangeTo) && draft.rangeTo < draft.rangeFrom;
      const bothOk = DATE_RE.test(draft.rangeFrom) && DATE_RE.test(draft.rangeTo) && !inverted;

      const hint =
        badFrom || badTo
          ? '日期格式要是 2026-11-02 这样'
          : inverted
            ? '结束日不能早于开始日'
            : bothOk
              ? `共 ${daysBetween(draft.rangeFrom, draft.rangeTo) + 1} 天，这几天系统不会排任何任务`
              : '不想填就跳过——但那样系统可能会把任务排进你的考试周。';

      return (
        <View style={styles.col}>
          <View style={styles.rangeRow}>
            <View style={styles.rangeField}>
              <AppText variant="caption" tone="textFaint">
                开始
              </AppText>
              <Input
                value={draft.rangeFrom}
                placeholder={q.placeholder ?? 'YYYY-MM-DD'}
                onChangeText={(v) => set({ rangeFrom: v.trim() })}
                keyboardType="numbers-and-punctuation"
              />
            </View>
            <View style={styles.rangeField}>
              <AppText variant="caption" tone="textFaint">
                结束
              </AppText>
              <Input
                value={draft.rangeTo}
                placeholder="YYYY-MM-DD"
                onChangeText={(v) => set({ rangeTo: v.trim() })}
                keyboardType="numbers-and-punctuation"
              />
            </View>
          </View>

          {/* 原因用固定几项而不是自由输入：它会作为 blackout.reason 出现在计划文件里，
              也会显示在「本周安排」的胶囊上，短短几个字最好读 */}
          <View style={styles.wrap}>
            {BLACKOUT_REASONS.map((r) => (
              <Chip
                key={r}
                tone="neutral"
                selected={draft.reason === r}
                accessibilityLabel={`原因：${r}`}
                onPress={() => set({ reason: draft.reason === r ? null : r })}
              >
                {r}
              </Chip>
            ))}
          </View>

          <AppText variant="caption" tone={badFrom || badTo || inverted ? 'danger' : 'textFaint'}>
            {hint}
          </AppText>
        </View>
      );
    }

    case 'text':
      return (
        <View style={styles.col}>
          {q.suggestions.length > 0 ? (
            <View style={styles.wrap}>
              {q.suggestions.map((sg) => (
                <Chip
                  key={sg}
                  tone="neutral"
                  selected={draft.text === sg}
                  accessibilityLabel={`填入「${sg}」`}
                  onPress={() => set({ text: sg })}
                >
                  {sg}
                </Chip>
              ))}
            </View>
          ) : null}
          <Input
            value={draft.text}
            placeholder={q.placeholder ?? '用自己的话说'}
            onChangeText={(v) => set({ text: v })}
            multiline
          />
        </View>
      );
  }
}

/** 单选/多选共用的一行。多选用方框、单选用圆点，形状本身就说明能不能多选 */
function OptionRow({
  label,
  selected,
  multiple = false,
  onPress,
}: {
  label: string;
  selected: boolean;
  multiple?: boolean;
  onPress: () => void;
}) {
  const t = useTokens();
  return (
    <Pressable
      accessibilityRole={multiple ? 'checkbox' : 'radio'}
      accessibilityState={multiple ? { checked: selected } : { selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.option,
        {
          backgroundColor: selected ? t.primarySoft : t.surfaceRaised,
          borderColor: selected ? t.primary : 'transparent',
        },
        pressed ? styles.pressed : null,
      ]}
    >
      <View
        style={[
          styles.mark,
          {
            borderRadius: multiple ? 5 : 999,
            backgroundColor: selected ? t.primary : 'transparent',
            borderColor: selected ? t.primary : t.borderStrong,
          },
        ]}
      >
        {selected ? (
          <AppText variant="caption" tone="onPrimary">
            ✓
          </AppText>
        ) : null}
      </View>
      <AppText variant="body" style={styles.optionLabel}>
        {label}
      </AppText>
    </Pressable>
  );
}

/**
 * 输入框直接用共享组件。
 *
 * 原来这里自己写了一份，和文件页那份是两套圆角/内边距/占位色；
 * 两处各写一遍的下场就是这个项目里已经见过的：一段悄悄跑偏，另一段没人改。
 */
function Input({ multiline = false, ...rest }: InputProps) {
  return <InputBase multiline={multiline} {...rest} />;
}

const styles = StyleSheet.create({
  col: {
    gap: space.md,
  },
  wrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  optionLabel: {
    flex: 1,
  },
  pressed: {
    opacity: 0.7,
  },
  mark: {
    width: 18,
    height: 18,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rangeRow: {
    flexDirection: 'row',
    gap: space.md,
  },
  rangeField: {
    flex: 1,
    gap: space.xs,
  },
});
