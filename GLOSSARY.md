# Glossary

## Case

一条可保存、可单独创建 Run 的测试定义。

## description

这条 Case 在验证什么。给人读，不参与执行。

## Group

一组对已有 Case 的引用。同一条 Case 可以被多个 Group 引用，Case 也可以不属于任何 Group。
按 Group 运行会为当时引用的每条 Case 创建一个 Run，这些 Run 属于同一批次。
删除 Group 不会删除被引用的 Case。
