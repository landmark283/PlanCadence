/**
 * 底部导航条。
 *
 * 刻意**自己画**，不用默认实现，也刻意**不用图标**：
 *
 *  1. 默认 tab bar 是 Material / iOS 两套平台惯例的混血，和「平台中立自有语言」
 *     的方向冲突（见 expo-ios-hig 技能里的 native-avoid-material-ui）；
 *  2. 图标要引 `@expo/vector-icons`（当前零额外依赖），而三个两字中文标签
 *     配上药丸高亮已经足够清楚——图标在这里是装饰，不是信息；
 *  3. 药丸高亮比「图标变色」更符合本项目用色调表达层级的做法。
 */
import { Pressable, StyleSheet, View } from 'react-native';
import type { BottomTabBarProps } from 'expo-router/js-tabs';

import { AppText } from '@/components/app-text';
import { layout, radius, space, touchTarget, useTokens } from '@/theme';

export function AppTabBar({ state, descriptors, navigation, insets }: BottomTabBarProps) {
  const t = useTokens();

  return (
    <View
      style={[
        styles.bar,
        { backgroundColor: t.surface, borderTopColor: t.border, paddingBottom: insets.bottom + space.sm },
      ]}
    >
      <View style={styles.inner}>
        {state.routes.map((route, index) => {
          const focused = state.index === index;
          const options = descriptors[route.key]?.options;
          const label = typeof options?.title === 'string' ? options.title : route.name;

          const onPress = () => {
            // 先问监听方要不要拦截（例如未保存时确认），这是 react-navigation 的约定
            const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
          };

          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={label}
              onPress={onPress}
              style={({ pressed }) => [
                styles.tab,
                focused ? { backgroundColor: t.primarySoft } : null,
                pressed ? styles.pressed : null,
              ]}
            >
              <AppText variant="label" tone={focused ? 'primary' : 'textFaint'}>
                {label}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    maxWidth: layout.maxContentWidth,
    width: '100%',
    alignSelf: 'center',
  },
  tab: {
    flex: 1,
    minHeight: touchTarget,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.6,
  },
});
