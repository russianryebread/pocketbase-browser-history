migrate((app) => {
    const users = app.findCollectionByNameOrId("users");
    if (!users.fields.getByName("role")) {
        users.fields.add(new SelectField({ name: "role", values: ["child", "parent"], maxSelect: 1 }));
    }
    // Members may authenticate, but only a superuser can assign a parent role.
    app.save(users);
});
